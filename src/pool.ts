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
  private host: VSCodePoolWorker | undefined;
  private startMessage: Extract<WorkerRequest, { type: 'start' }> | undefined;
  private forward: LineIpc | undefined; // the task's placeholder a pumped bridge emits into

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly instances: Map<string, VSCodePoolWorker>
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) {
      case 'start': this.startMessage = message; return this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true });
      case 'run': case 'collect':
        return void this.acquire(message);
      case 'stop': return this.ipc?.emit('message', { type: 'stopped', __vitest_worker_response__: true }); // normal completion: forced cancels skip it; the host stays warm
      default:
        this.host?.ipc?.send(message);
    }
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() { this.ipc = new LineIpc(new net.Socket()); } // vitest subscribes here; acquire() pumps the serving bridge into it
  private async boot() {
    process.once('exit', () => { if (this.profilePath) { this.ipc?.destroy(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4000); this.cleanup(); } }); // outlive the dying child's final profile writes

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
        for (const event of ['message', 'error', 'exit']) this.ipc.on(event, (...args) => this.forward?.emit(event, ...args)); // pump into the serving facade's placeholder
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
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    if (this.options.reuseWorker === false) await (this.host ?? this).stop(); // cold retires; normal parks in send()
  }
  private async acquire(message: Extract<WorkerRequest, { type: 'run' | 'collect' }>) {
    const key = JSON.stringify([this.poolOptions.project.name, ...message.context.files.map((file) => file.filepath).sort()]);
    this.host = this.instances.get(key) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances); // adopt or create: this facade never mutates
    this.instances.set(key, this.host);
    try {
      this.host.forward = this.ipc; // pump the serving bridge into this facade's placeholder
      if (!this.host.server) { // cold-only hold (verified): a fresh EH wedges without a processed start
        // (setupContext.rpc undefined); warm reruns skip it — the parked EH's setup persists
        await this.host.boot(); this.host.ipc?.send(this.startMessage);
        await Promise.race([new Promise((resolve) => this.ipc?.once('message', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out starting the extension-host Vitest worker.')), 30_000).unref())]);
      }
      this.host.ipc?.send(message);
    } catch (error) {
      this.instances.delete(key); await this.host?.cleanup();
      this.ipc?.emit('error', error);
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
}
