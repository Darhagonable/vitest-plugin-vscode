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

process.once('SIGTERM', () => process.exit(0)); // killed forks never run exit hooks: run them

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
      else if (message.type === 'stop') void this.bridge?.dispose(false).catch(() => undefined);
      this.held = message.type === 'start' ? message : this.held;
      return void this.events.emit('message', { type: message.type === 'start' ? 'started' : 'stopped', __vitest_worker_response__: true });
    }
    if (this.bridge) return void this.bridge.ipc?.send(message);
    if (message.type === 'run' || message.type === 'collect') {
      this.key = message.context.files.map(file => file.filepath).join('\n');
      this.attach(message).catch(error => { this.emitError(error); void this.bridge?.dispose(false).catch(() => undefined); });
    }
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // deferred to send(): the run request picks the bridge
  async stop() {
    await this.dispose(false);
  }

  private async boot() {
    try {
      await this.connect();
    } catch (error) {
      await this.dispose(true);
      throw error;
    }

    this.run?.catch((error) => {
      if (!this.stopping)
        this.emitError(error);
    });
  }

  private async attach(message: WorkerRequest) {
    const bridge = this.instances.get(this.key) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances);
    this.instances.delete(this.key); // one bridge is never handed to two tasks
    if (!bridge.ipc) await bridge.boot();
    (this.bridge = bridge).events = this.events;
    // 'start' is handled asynchronously; its reply (or a 30s bound, for a mute host) orders the run.
    const reply = new Promise<void>(resolve => this.events.on('message', (m: { type?: string }) => { if (m.type === 'started') resolve(); }));
    this.bridge?.ipc?.send(this.held);
    await Promise.race([reply, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('VS Code worker never finished starting.')), 30_000).unref())]);
    this.send(message);
  }

  private async connect() {
    const { server, port, connected } = await this.createServer();
    this.server = server;

    // Anchor the download cache at the project root so nothing leaks outside
    // the package in monorepos. Per-worker profiles live in the OS temp dir:
    // short (unix socket path limits) and cleaned up on stop.
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    process.once('exit', () => {
      if (this.profilePath) rmSync(this.profilePath, { recursive: true, force: true });
    });

    // Per-worker user-data and extensions dirs go in first: concurrent VS Code
    // instances never share state and nothing lands at the CWD default.
    // Skipped under reuseMachineInstall, which runTests() also honors —
    // otherwise it would inject its own default profile dirs. User
    // launchArgs append last so they win by ordering.
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

    // VS Code's Vitest extension runs test processes under Electron-as-Node.
    // The spawned VS Code must start as Electron, not inherit that mode.
    // runTests() merges process.env, so sanitize the environment directly.
    delete process.env.ELECTRON_RUN_AS_NODE;

    this.run = runTests({
      vscodeExecutablePath: this.options.vscodeExecutablePath,
      version: process.env.VSCODE_VERSION ?? this.options.version,
      cachePath: this.options.cachePath,
      extensionDevelopmentPath: this.options.extensionDevelopmentPath ?? config.root,
      // Path to the bundled vscode worker for the extension host to import.
      extensionTestsPath: require.resolve('./vscode-worker.mjs'),
      reuseMachineInstall: this.options.reuseMachineInstall,
      extensionTestsEnv: {
        VITEST_RUNNER_IPC_HOST: '127.0.0.1',
        VITEST_RUNNER_IPC_PORT: String(port)
      },
      launchArgs,
      reporter: new SilentReporter()
    });
    let bridgeConnected = false;
    const connectedBeforeExit = connected.then(() => {
      bridgeConnected = true;
    });
    const exitedBeforeConnect = this.run.then(
      () => {
        if (!bridgeConnected)
          throw new Error('VS Code exited before the extension-host Vitest bridge connected.');
      },
      (error) => {
        if (!bridgeConnected)
          throw error;
      }
    );

    await Promise.race([
      connectedBeforeExit,
      exitedBeforeConnect,
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error('Timed out waiting for the VS Code extension-host Vitest bridge to connect.'));
        }, config.inspector.waitForDebugger ? 300_000 : 30_000).unref();
      })
    ]);
  }

  async dispose(hard: boolean) {
    this.stopping = true;

    try {
      if (hard) {
        this.ipc?.destroy();
      } else {
        this.ipc?.close();
        // No timeout: vitest's own teardownTimeout bounds the whole pool.
        await this.run?.then(undefined, (error) => {
          if (!(error instanceof TestRunFailedError))
            throw error;
        });
      }

      this.server?.close();
    } finally {
      this.ipc = undefined;
      this.server = undefined;
      this.run = undefined;
      this.stopping = false;

      if (this.profilePath) {
        await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
        this.profilePath = undefined;
      }
    }
  }

  canReuse() {
    return this.options.reuseWorker !== false;
  }

  private async createServer() {
    const server = net.createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    const address = server.address();

    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('Could not allocate IPC port for VS Code Vitest worker.');
    }

    server.on('connection', (socket) => {
      this.ipc = new LineIpc(socket);
      this.ipc.on('message', (message) => this.events.emit('message', message));
      this.ipc.on('error', (error) => this.emitError(error));
      this.ipc.on('close', () => {
        this.ipc = undefined; // a closed bridge is never adopted again
        if (!this.stopping)
          this.events.emit('exit');
      });
    });

    return {
      server,
      port: address.port,
      connected: once(server, 'connection')
    };
  }

  private emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}
