import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
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

process.on('SIGTERM', () => process.exit(143)); // signal deaths skip 'exit' hooks: re-enter

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private host!: VSCodePoolWorker; // set by bind(); 'run'/'stop' never precede it
  private buffered: unknown[] = [];

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly instances: Map<string, VSCodePoolWorker> = new Map()
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.events.off(event, callback);
  }

  send(message: WorkerRequest) {
    // 'start' acks locally (replayed in bind); 'stop' never forwards and
    // follows only normal completion: park — quarantined, the bind-time
    // claim stands — or dispose; forced cancels leave the claim to closeServer.
    if (message.type === 'start' || message.type === 'stop') {
      this.events.emit('message', { type: message.type === 'start' ? 'started' : 'stopped', __vitest_worker_response__: true });
      if (message.type === 'start') this.buffered.push(message);
      else if (this.canReuse() && this.poolOptions.project.config.watch) this.host.events = new EventEmitter();
      else void this.host.dispose(!this.host.ipc);
    } else if (message.type === 'run' || message.type === 'collect')
      this.bind(message).catch((error) => { void this.host.dispose(true); this.emitError(error); });
    else this.host?.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // the task's files arrive only with the run request

  async stop() {
    await this.dispose(false);
  }

  private async bind(runRequest: Extract<WorkerRequest, { type: 'run' | 'collect' }>) {
    const key = `${this.poolOptions.project.name}|${runRequest.context.files.map((file) => file.filepath)}`;
    this.instances.set(key, this.host = this.instances.get(key) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances));
    this.host.events = this.events;
    if (!this.host.ipc) await this.host.connect();
    for (const buffered of this.buffered) this.host.ipc?.send(buffered);
    await Promise.race([once(this.events, 'gate'), new Promise((_, reject) => // gate on the host's genuine 'started': its runtime handles 'start' async
      setTimeout(reject, 60_000, new Error('Timed out waiting for the extension host to accept a run.')).unref())]);
    this.host.ipc?.send(runRequest);
  }

  private async connect() {
    const { server, port, connected } = await this.createServer();
    this.server = server;

    // Anchor the download cache at the project root so nothing leaks outside
    // the package in monorepos. Per-worker profiles live in the OS temp dir:
    // short (unix socket path limits) and cleaned up on stop.
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    // a run dying before closeServer still loses its profile: wait out its host, sweep
    process.once('exit', () => {
      if (!this.profilePath) return;
      this.ipc?.destroy();
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      require('node:fs').rmSync(this.profilePath, { recursive: true, force: true });
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
        this.run?.catch(() => {}); // a late rejection must not surface unhandled
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
      this.ipc.on('message', (message: { type?: string }) => { if (message.type === 'started') this.events.emit('gate'); });
      this.ipc.on('error', (error) => this.emitError(error));
      this.ipc.on('close', () => {
        for (const [key, host] of this.instances) if (host === this) this.instances.delete(key);
        if (!this.stopping) { void this.dispose(true); this.events.emit('exit'); }
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
