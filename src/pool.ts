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

const rejectAfter = (ms: number, message: string) =>
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref());

/** The run/collect request — the sole pool message naming which files to test. */
type RunRequest = Extract<WorkerRequest, { type: 'run' | 'collect' }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRunRequest(message: unknown): message is RunRequest {
  return isRecord(message) && (message.type === 'run' || message.type === 'collect');
}

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
  private startMessage: unknown;
  private parked = false;
  private dead = false;

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
    if (isRunRequest(message))
      void this.dispatch(message);
    else if (isRecord(message) && (message.type === 'start' || message.type === 'stop')) {
      // vitest sends the run request (the sole message naming files) only after the 'started' reply.
      if (message.type === 'start')
        this.startMessage = message;
      this.events.emit('message', { type: message.type === 'start' ? 'started' : 'stopped', __vitest_worker_response__: true });
    } else
      this.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {}

  async stop() {
    if (!(this.host ?? this).parked)
      await (this.host ?? this).dispose(false);
  }

  private async dispatch(request: RunRequest) {
    const key = this.key = `${this.poolOptions.project.config.root}\0${request.context.files.map((file) => file.filepath).join()}`;
    const parked = this.instances.get(key);
    this.instances.delete(key);
    if (parked && parked.ipc && !parked.dead) {
      // Relay: the host's wired bridge handlers now feed my pool runner.
      parked.parked = false;
      this.host = parked;
      parked.events = this.events;
      this.ipc = parked.ipc;
      parked.ipc.send(request);
      return;
    }
    try {
      const ipc = await this.connect();
      // If the process dies before closeServer: destroy the bridge, drop the profile.
      process.once('exit', () => {
        ipc.destroy();
        if (this.profilePath)
          rmSync(this.profilePath, { recursive: true, force: true });
      });
      this.run?.catch(() => undefined);
      ipc.send(this.startMessage);
      await Promise.race([once(ipc, 'message'), rejectAfter(30_000, 'VS Code extension host did not report startup.')]);
      ipc.send(request);
    } catch (error) {
      await this.dispose(true).catch(() => undefined);
      this.emitError(error);
    }
  }

  private async connect(): Promise<LineIpc> {
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
      rejectAfter(config.inspector.waitForDebugger ? 300_000 : 30_000,
        'Timed out waiting for the VS Code extension-host Vitest bridge to connect.')
    ]);
    return this.ipc!;
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
      // The host parks itself when its run finishes, before the pool can schedule the next task.
      this.ipc.on('message', (message: unknown) => {
        if (isRecord(message) && message.type === 'testfileFinished' && this.key
          && this.options.reuseWorker !== false && this.poolOptions.project.config.watch) {
          this.parked = true;
          this.instances.set(this.key, this);
        }
        this.events.emit('message', message);
      });
      this.ipc.on('error', (error) => this.emitError(error));
      this.ipc.on('close', () => {
        this.dead = true;
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
