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
  private ipc: LineIpc | undefined = new LineIpc(new net.Socket()); // placeholder: vitest subscribes here before files exist
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

  constructor(
    private readonly instances: Map<string, VSCodePoolWorker>,
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) {
      case 'start': // waitForStart gates the run request — and the file — behind this reply
        return this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true });
      case 'run': case 'collect': return void this._start(message.context.files[0].filepath, message);
      case 'stop': // teardown waits for this; the parked host must not receive it
        return this.ipc?.emit('message', { type: 'stopped', __vitest_worker_response__: true });
      default: return void this.ipc?.emit('out', message); // rpc envelopes, ferried to the host's bridge
    }
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {}

  private async _boot() {
    process.once('exit', () => this.cleanup());
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
        this.ipc = new LineIpc(socket);
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
          ...this.options.extensionTestsEnv,
          VITEST_RUNNER_IPC_HOST: '127.0.0.1',
          VITEST_RUNNER_IPC_PORT: String(address.port)
        },
        stdout: this.options.stdout,
        stderr: this.options.stderr,
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
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  private async _start(file: string, request: WorkerRequest) {
    const host = this.instances.get(file) ?? new VSCodePoolWorker(this.instances, this.poolOptions, this.options); // adopt or create
    this.instances.set(file, host);
    const fresh = !host.server; // captured pre-boot: main's field is the launched marker
    try {
      if (fresh) await host._boot();
      for (const event of ['message', 'error', 'exit']) host.ipc?.on(event, (...args) => this.ipc?.emit(event, ...args));
      this.ipc?.on('out', (message: unknown) => host.ipc?.send(message)); // ferries send()'s default traffic to the EH
      if (fresh) {
        host.ipc?.send({ type: 'start', poolId: 1, workerId: 1, __vitest_worker_request__: true, options: { reportMemory: false }, context: { environment: this.poolOptions.environment, config: this.poolOptions.project.serializedConfig, pool: 'vscodePool' }, traces: { enabled: false } }); // reconstructed: poolId/workerId only label env vars; setup rides config+environment
        await Promise.race([new Promise((resolve) => this.ipc?.once('message', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out starting the extension-host Vitest worker.')), 30_000).unref())]);
      }
      host.ipc?.send(request);
    } catch (error) {
      this.instances.delete(file);
      this.ipc?.emit('error', error);
    }
  }
  async stop() {} // parking: the placeholder must not close — its 'exit' would fail vitest's runner


  async cleanup() { // public: shared by the exit hook and the plugin's closeServer
    this.stopping = true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000); // outlive the dying child's final profile writes
    this.ipc?.destroy();
    this.server?.close();
    this.ipc = undefined;
    this.server = undefined;
    this.run = undefined;
    if (this.profilePath) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000); // outlive the dying child's final writes
      rmSync(this.profilePath, { recursive: true, force: true });
      this.profilePath = undefined;
    }
    this.stopping = false;
  }

  canReuse() {
    return this.options.reuseWorker !== false;
  }
}
