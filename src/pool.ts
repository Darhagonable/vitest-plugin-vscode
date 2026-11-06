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

  private events = new EventEmitter(); // retargeted when a parked host is adopted
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private host: VSCodePoolWorker | undefined;
  private startMessage: Extract<WorkerRequest, { type: 'start' }> | undefined;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly instances: Map<string, VSCodePoolWorker>
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.events.off(event, callback);
  }

  send(message: WorkerRequest) {
    if (message.type === 'start') {
      // Files arrive only with the run request: answer vitest now, replay in acquire().
      this.startMessage = message;
      return this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
    }
    if (message.type === 'run' || message.type === 'collect')
      return void this.acquire(message);
    if (message.type === 'stop') { // normal completion: forced cancels skip it
      this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
      return; // not forwarded: the host stays warm past its task
    }
    this.host?.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // the host is picked once the run request names the files

  private async boot() {
    // The exit sweep must outlive the dying child's final profile writes.
    process.once('exit', () => { this.ipc?.destroy(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000); this.cleanup(); });
    if (this.ipc)
      return;

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
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    // Normal stops park in send(); only cold-boot mode retires the host.
    if (this.options.reuseWorker === false) await (this.host ?? this).stop();
  }

  private async acquire(message: Extract<WorkerRequest, { type: 'run' | 'collect' }>) {
    const key = JSON.stringify([this.poolOptions.project.name, ...message.context.files.map((file) => file.filepath).sort()]);
    try {
      this.host = this.instances.get(key) ?? this; // adopt or become the host
      if (this.host === this) {
        if (this.options.reuseWorker !== false) this.instances.set(key, this);
        await this.boot();
      }
      if (this.host !== this) this.host.events = this.events; // route its bridge to this task
      this.host.ipc?.send(this.startMessage); // its first reply acks the replay
      await Promise.race([once(this.events, 'message'), new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out starting the extension-host Vitest worker.')), 30_000).unref())]);
      this.host.ipc?.send(message);
    } catch (error) {
      this.instances.delete(key);
      await (this.host ?? this).cleanup();
      this.emitError(error);
    }
  }

  async cleanup() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();
    this.ipc = undefined;
    this.server = undefined;
    this.run = undefined;
    if (this.profilePath) {
      rmSync(this.profilePath, { recursive: true, force: true });
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
