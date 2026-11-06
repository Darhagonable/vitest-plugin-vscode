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
import type { PoolOptions, PoolWorker, WorkerRequest, WorkerResponse } from 'vitest/node';
import type { VSCodeOptions } from './plugin';

const require = createRequire(import.meta.url);
type StartRequest = Extract<WorkerRequest, { type: 'start' }>;
type RunRequest = Extract<WorkerRequest, { type: 'run' | 'collect' }>;

// A SIGTERM'd fork never runs exit hooks; exiting normally re-fires them.
process.once('SIGTERM', () => process.exit(0));

function isWorkerRequest(message: unknown): message is WorkerRequest {
  return typeof message === 'object' && message !== null
    && '__vitest_worker_request__' in message && message.__vitest_worker_request__ === true;
}

function isWorkerResponse(message: unknown): message is WorkerResponse {
  return typeof message === 'object' && message !== null
    && '__vitest_worker_response__' in message && message.__vitest_worker_response__ === true;
}

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  busy = false; // a task owns this host (R5): adopters wait for 'parked'
  dead = false; // the bridge died under this host
  private host: VSCodePoolWorker | undefined; // worker whose bridge closures route traffic
  private startMessage: StartRequest | undefined; // held until the run request names the files
  private key: string | undefined; // registry key of the host this worker holds

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

  send(message: unknown) {
    if (isWorkerRequest(message)) {
      if (message.type === 'start') {
        // The files arrive only with the run request, so vitest's handshake
        // is answered here and replayed to the host in acquire().
        this.startMessage = message;
        return this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
      }
      if (message.type === 'run' || message.type === 'collect')
        return void this.acquire(message);
    }
    this.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // the host is picked once the run request names the files

  async stop() {
    this.busy = false;
    this.events.emit('parked'); // wake adoption waiters
    const { key } = this;
    if (key && (this.dead || (this.host && this.options.reuseWorker === false))) {
      this.instances.delete(key); // dead bridge or cold-boot mode: retire it
      await this.dispose(this.dead);
    } // else: it stays parked for the next run of these files
  }

  private async acquire(message: RunRequest) {
    const key = JSON.stringify([this.poolOptions.project.name, ...message.context.files.map((file) => file.filepath).sort()]);
    this.key = key;
    this.busy = true;
    try {
      let host = this.instances.get(key);

      while (host?.busy) { // wait out the previous task's stop handshake
        await once(host.events, 'parked');
        host = this.instances.get(key);
      }
      this.instances.set(key, this); // claim the slot for this worker's host
      if (host && !host.dead && host.host && host.ipc) {
        // Resurrect the parked host: harvest its bridge and retarget the routing.
        Object.assign(this, { ipc: host.ipc, run: host.run, server: host.server, profilePath: host.profilePath, host: host.host });
        host.host.events = this.events;
      } else {
        this.host = this;
        await this.connect(); // a fresh boot (dead husks wait for the exit hook)
      }

      if (!this.busy) return; // cancelled while booting: stay parked
      this.events.on('exit', () => (this.dead = true));
      const { ipc } = this;
      if (!ipc) throw new Error('The extension-host bridge is not connected.');
      ipc.send(this.startMessage); // must not overtake the async setup
      await Promise.race([once(this.events, 'started'), new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out starting the extension-host Vitest worker.')), 30_000).unref())]);
      if (this.busy) ipc.send(message);
    } catch (error) {
      this.instances.delete(key);
      await this.dispose(true);
      this.emitError(error);
    }
  }

  private async connect() {
    process.once('exit', () => this.dispose(true)); // failed runs never reach closeServer
    const { server, port, connected } = await this.createServer();
    this.server = server;

    // Anchor the download cache at the project root so nothing leaks outside
    // the package in monorepos. Per-worker profiles live in the OS temp dir:
    // short (unix socket path limits) and cleaned up on stop.
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);

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
        rmSync(this.profilePath, { recursive: true, force: true });
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
      this.ipc.on('message', (message: unknown) => this.events.emit(isWorkerResponse(message) && message.type === 'started' ? 'started' : 'message', message));
      this.ipc.on('error', (error) => this.emitError(error));
      this.ipc.on('close', () => {
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
