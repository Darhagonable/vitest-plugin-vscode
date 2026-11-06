import { EventEmitter, once } from 'node:events';
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

  private events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private key: string | undefined;
  private host: VSCodePoolWorker | undefined;
  private startMessage: Extract<WorkerRequest, { type: 'start' }> | undefined;

  constructor(private readonly poolOptions: PoolOptions, private readonly options: VSCodeOptions, private readonly instances: Map<string, VSCodePoolWorker>) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.events.off(event, callback);
  }

  send(message: WorkerRequest) {
    if (message.type === 'run' || message.type === 'collect')
      return void this.dispatch(message);
    if (message.type === 'start') this.startMessage = message;
    // {stop} arrives only after a normally finished run — forced cancels skip posting it.
    if (message.type === 'stop' && this.key && this.options.reuseWorker !== false && this.poolOptions.project.config.watch)
      this.instances.set(this.key, this.host ??= this);
    if (message.type === 'start' || message.type === 'stop')
      this.events.emit('message', { type: message.type === 'start' ? 'started' : 'stopped', __vitest_worker_response__: true });
    else this.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {}

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
      const server = net.createServer((socket) => {
        this.ipc = new LineIpc(socket);
        this.ipc.on('message', (message) => this.events.emit('message', message));
        this.ipc.on('error', (error) => this.emitError(error));
        this.ipc.on('close', () => {
          if (!this.stopping)
            this.events.emit('exit');
        });
      });

      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      this.server = server;

      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Could not allocate IPC port for VS Code Vitest worker.');
      }

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
        once(server, 'connection'),
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
          this.emitError(error);
      });
      return this.ipc!;
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    if (this.instances.get(this.key ?? '') === (this.host ?? this)) return; // parked: the host outlives this task
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
    const parked = this.instances.get(this.key);
    this.instances.delete(this.key);
    if (parked?.ipc) {
      (this.host = parked).events = this.events;
      (this.ipc = parked.ipc).send(request);
    } else try {
      const ipc = await this.boot();
      process.once('exit', () => this.cleanup());
      ipc.send(this.startMessage);
      await Promise.race([once(ipc, 'message'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('VS Code extension host did not report startup.')), 30_000).unref())]);
      ipc.send(request);
    } catch (error) {
      await this.stop().catch(() => undefined);
      this.emitError(error);
    }
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

  private emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}
