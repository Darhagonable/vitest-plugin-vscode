import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import {
  runTests,
  SilentReporter,
  TestRunFailedError
} from '@vscode/test-electron';
import { LineIpc } from './utils/ipc';
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node';
import type { VSCodeOptions } from './plugin';

const require = createRequire(import.meta.url);

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private key: string | undefined;
  private startMessage: Extract<WorkerRequest, { type: 'start' }> | undefined; // cold-only hold (see boot)
  private host: VSCodePoolWorker | undefined; // the boot worker whose bridge serves this task
  private bridge: LineIpc | undefined; // the host's real socket; sends route here

  constructor(private readonly poolOptions: PoolOptions, private readonly options: VSCodeOptions, private readonly instances: Map<string, VSCodePoolWorker>) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) {
      case 'run': case 'collect': return void this.dispatch(message);
      case 'start': case 'stop': // shared synthetic ack; start also holds its message for the cold replay
        this.startMessage = message.type === 'start' ? message : this.startMessage;
        this.ipc?.emit('message', { type: message.type === 'start' ? 'started' : 'stopped', __vitest_worker_response__: true });
        if (message.type === 'stop' && this.key && this.options.reuseWorker !== false && this.poolOptions.project.config.watch)
          this.instances.set(this.key, this.host ?? this); // {stop} = normal completion only; cancels never post it
        return;
      default: this.bridge?.send(message);
    }
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() { this.ipc = new LineIpc(new net.Socket()); this.ipc.on('error', () => {}); } // placeholder: vitest's verbatim on/off lives here for this task's whole life

  private async boot(): Promise<LineIpc> {
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);

    // User launchArgs append last so they win by ordering.
    const launchArgs: string[] = [];

    if (!this.options.reuseMachineInstall) {
      launchArgs.push(
        `--extensions-dir=${path.join(this.profilePath, 'extensions')}`,
        `--user-data-dir=${path.join(this.profilePath, 'user-data')}`,
        '--disable-extensions'
      );
    }

    if (config.inspector.enabled)
      launchArgs.push(config.inspector.waitForDebugger
        ? `--inspect-brk-extensions=${config.inspector.port ?? 9229}`
        : `--inspect-extensions=${config.inspector.port ?? 9229}`);

    if (this.options.launchArgs)
      launchArgs.push(...this.options.launchArgs);

    // The spawned VS Code must start as Electron, not inherit the
    // Vitest extension's Electron-as-Node mode.
    delete process.env.ELECTRON_RUN_AS_NODE;

    try {
      this.server = net.createServer((socket) => {
        this.bridge = new LineIpc(socket);
        for (const event of ['message', 'error', 'exit']) this.bridge.on(event, (arg) => this.ipc === this.bridge || this.ipc?.emit(event, arg)); // never re-emit into the bridge (post-swap self-recycle)
      });

      await once(this.server.listen(0, '127.0.0.1'), 'listening');
      const address = this.server.address();

      if (!address || typeof address === 'string')
        throw new Error('Could not allocate IPC port for VS Code Vitest worker.');

      this.run = runTests({
        vscodeExecutablePath: this.options.vscodeExecutablePath,
        version: process.env.VSCODE_VERSION ?? this.options.version,
        cachePath: this.options.cachePath,
        extensionDevelopmentPath: this.options.extensionDevelopmentPath ?? config.root,
        extensionTestsPath: require.resolve('./vscode-worker.mjs'),
        reuseMachineInstall: this.options.reuseMachineInstall,
        extensionTestsEnv: {
          VITEST_RUNNER_IPC_HOST: '127.0.0.1',
          VITEST_RUNNER_IPC_PORT: String(address.port)
        },
        launchArgs: launchArgs,
        reporter: new SilentReporter()
      });

      await Promise.race([
        once(this.server, 'connection'),
        this.run.then(() => {
          throw new Error('VS Code exited before the extension-host Vitest bridge connected.');
        }),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Timed out waiting for the VS Code extension-host Vitest bridge to connect.'));
          }, config.inspector.waitForDebugger ? 300_000 : 30_000).unref();
        })
      ]);

      this.run.catch((error) => {
        if (!this.stopping)
          this.ipc?.emit('error', error);
      });
      process.once('exit', () => { this.ipc = this.bridge ?? this.ipc; this.cleanup(); }); // R2 sweep, idempotent per host
      this.bridge!.send(this.startMessage); // cold-only hold: the host's init() needs the real 'start'
      await Promise.race([once(this.bridge!, 'message'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('VS Code extension host did not report startup.')), 30_000).unref())]); // and the request must not race its async handler
      return this.bridge!;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    if (this.instances.get(this.key ?? '') === (this.host ?? this)) return; // parked: the host outlives this task
    this.ipc = this.bridge ?? this.ipc; // teardown targets the real bridge (offs already hit the placeholder)
    this.stopping = true;
    try {
      this.ipc?.close();
      await this.run?.catch((error) => {
        if (!(error instanceof TestRunFailedError))
          throw error;
      });
    } finally {
      await this.cleanup();
    }
  }

  private async dispatch(request: Extract<WorkerRequest, { type: 'run' | 'collect' }>) {
    this.key = `${this.poolOptions.project.config.root}\0${request.context.files.map((file) => file.filepath).join()}`;
    const parked = this.instances.get(this.key); this.instances.delete(this.key);
    try {
      if (parked) (this.host = parked).ipc = this.ipc; // retarget the host's pump at this task's placeholder
      const bridge = this.bridge = parked?.bridge ?? await this.boot(); // boot = connect + 'start' handshake
      bridge.send(request);
    } catch (error) { this.ipc?.emit('error', error); } // vitest's reject → force-stop tears down
  }
  private async cleanup() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();
    this.ipc = undefined;
    this.server = undefined;
    this.run = undefined;
    if (this.profilePath) {
      rmSync(this.profilePath, { recursive: true, force: true }); // sync: reused by the process-exit hook
      this.profilePath = undefined;
    }
    this.stopping = false;
  }

  canReuse() {
    return this.options.reuseWorker !== false;
  }
}
