import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
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

/** Every message vitest's pool sends a worker carries this marker. */
function isWorkerRequest(message: unknown): message is WorkerRequest {
  return typeof message === 'object' && message !== null
    && '__vitest_worker_request__' in message && message.__vitest_worker_request__ === true
    && 'type' in message && typeof message.type === 'string';
}

/** Every reply the extension host sends back to the pool carries this marker. */
function isWorkerResponse(message: unknown): message is WorkerResponse {
  return typeof message === 'object' && message !== null
    && '__vitest_worker_response__' in message && message.__vitest_worker_response__ === true
    && 'type' in message && typeof message.type === 'string';
}

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private host: VSCodePoolWorker | undefined;
  private file: string | undefined;
  private startRequest: WorkerRequest | undefined;
  private clean = false;

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
    // Answer the start handshake in place of the extension host: the file
    // this task runs is only named by the run request that follows it.
    if (isWorkerRequest(message) && message.type === 'start') {
      this.startRequest = message;
      return this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
    }
    if (isWorkerRequest(message) && (message.type === 'run' || message.type === 'collect') && !this.file) {
      const file = this.file = message.context.files[0]?.filepath;
      const parked = file ? this.instances.get(file) : undefined;
      if (file)
        this.instances.delete(file);
      this.host = parked ?? this;
      void this.runSession(this.host, message, !parked);
      return;
    }
    if (!this.ipc) {
      this.emitError(new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // connect lazily from send(): the run request names the file

  async stop() {
    // Park the cleanly finished instance for this file's next run, watch mode
    // only; anything else — and anything displaced — is retired.
    if (this.clean && this.ipc && this.file && this.host && this.options.reuseWorker !== false && this.poolOptions.project.config.watch) {
      void this.instances.get(this.file)?.dispose(false);
      this.instances.set(this.file, this.host);
    } else {
      await this.host?.dispose(false);
    }
  }

  private async runSession(host: VSCodePoolWorker, request: WorkerRequest, fresh: boolean) {
    try {
      if (fresh)
        await this.connect();

      host.events = this.events; // the socket's wiring now feeds this task
      const { ipc, run } = host;
      if (!ipc || !run)
        throw new Error('The VS Code extension-host bridge is not connected.');
      this.ipc = ipc;
      // One filtered listener watches the reply stream for the whole session:
      // it resolves the start gate, and its own removal marks a clean stop.
      let started: (reply: WorkerResponse) => void = () => {};
      const gate = new Promise<WorkerResponse>((resolve) => (started = resolve));
      const onMessage = (message: unknown) => {
        if (!isWorkerResponse(message))
          return;
        if (message.type === 'started')
          started(message);
        if (message.type === 'stopped') {
          this.clean = true;
          ipc.off('message', onMessage);
        }
      };
      ipc.on('message', onMessage);
      // Replay "start" and await the real "started" reply before the run
      // request: the extension host handles the two concurrently.
      ipc.send(this.startRequest);
      const reply = await Promise.race([
        gate,
        run.then(() => { throw new Error('The VS Code extension host exited.'); }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for the VS Code extension host to start.')), 30_000).unref())
      ]);
      if (reply.type === 'started' && reply.error !== undefined)
        throw reply.error;
      ipc.send(request);
    } catch (error) {
      this.emitError(error);
    }
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
      this.ipc?.destroy(); // the instance exits once its bridge closes
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); // outlive its final writes
      if (this.profilePath) { try { rmSync(this.profilePath, { recursive: true, force: true }); } catch {} }
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
