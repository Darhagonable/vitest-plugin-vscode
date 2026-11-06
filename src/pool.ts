import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { rm } from 'node:fs/promises';
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
  private bridge: VSCodePoolWorker | undefined;
  private held: WorkerRequest | undefined;
  private key = '';
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

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
    if (message.type === 'stop' || (message.type === 'start' && !this.bridge)) {
      // Synthetic acks: the files arrive only after 'started' (hold that
      // message for the bridge they pick); 'stop' comes only after a completed
      // task — park the warm bridge (never one still unwinding) or kill it.
      if (message.type === 'stop' && this.bridge && this.poolOptions.project.config.watch && this.options.reuseWorker !== false)
        this.instances.set(this.key, this.bridge);
      else if (message.type === 'stop') void this.bridge?.stop().catch(() => undefined);
      this.held = message.type === 'start' ? message : this.held;
      return void this.events.emit('message', { type: message.type === 'start' ? 'started' : 'stopped', __vitest_worker_response__: true });
    }
    if (this.bridge) return void this.bridge.ipc?.send(message);
    if (message.type === 'run' || message.type === 'collect') {
      this.key = message.context.files.map(file => file.filepath).join('\n');
      this.attach(message).catch(error => { this.emitError(error); void this.bridge?.stop().catch(() => undefined); });
    }
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // deferred to send(): the run request picks the bridge

  private async boot() {
    if (this.ipc)
      return;

    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    process.once('exit', () => {
      if (this.profilePath) rmSync(this.profilePath, { recursive: true, force: true });
    });

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
          this.ipc = undefined; // a closed bridge is never adopted again
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

  private async cleanup() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();
    this.ipc = undefined;
    this.server = undefined;
    this.run = undefined;
    if (this.profilePath) {
      await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
      this.profilePath = undefined;
    }
    this.stopping = false;
  }

  canReuse() {
    return this.options.reuseWorker !== false;
  }

  private async attach(message: WorkerRequest) {
    const bridge = this.instances.get(this.key) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances);
    this.instances.delete(this.key); // one bridge is never handed to two tasks
    if (!bridge.ipc) await bridge.boot();
    (this.bridge = bridge).events = this.events;
    // 'start' is handled asynchronously; its reply (or a 30s bound, for a mute host) orders the run.
    const reply = new Promise<void>(resolve => this.events.on('message', (m: { type?: string }) => { if (m.type === 'started') resolve(); }));
    bridge.ipc?.send(this.held);
    await Promise.race([reply, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('VS Code worker never finished starting.')), 30_000).unref())]);
    bridge.ipc?.send(message);
  }

  private emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}
