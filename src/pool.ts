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
import type { PoolOptions, PoolWorker } from 'vitest/node';
import type { VSCodeOptions } from './plugin';

const require = createRequire(import.meta.url);

type RunRequest = { context: { files: { filepath: string }[] } };

// Watch-mode reuse: a worker parks itself by resolving the handoff that the
// next task for the same files awaits.
const handoffs = new Map<string, Promise<VSCodePoolWorker | undefined>>();

/** Dispose every parked extension host; called when the Vite server closes. */
export async function flushParked() {
  await Promise.all([...handoffs.values()].map(async (parked) => {
    const worker = await parked;
    await worker?.dispose(false).catch(() => undefined);
  }));
}

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private handoff: ((worker: VSCodePoolWorker | undefined) => void) | undefined;
  private startMessage: unknown;
  private dead = false;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.events.off(event, callback);
  }

  send(message: unknown) {
    const { type } = message as { type?: string };

    if (type === 'start') {
      // The files naming this worker's extension host only arrive with the
      // run request, which vitest sends after this reply — acknowledge here.
      this.startMessage = message;
      this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
      return;
    }

    if (type === 'run' || type === 'collect') {
      void this.dispatch(message as RunRequest);
      return;
    }

    if (type === 'stop') {
      // Stay warm between runs, like vitest's isolate: false shared runners.
      this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
      return;
    }

    this.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // The extension host is adopted (or booted) on the run request.
  }

  async stop() {
    const handoff = this.handoff;
    this.handoff = undefined;
    const keep = !!handoff && this.options.reuseWorker !== false
      && this.poolOptions.project.config.watch && !this.dead && !!this.ipc;
    handoff?.(keep ? this : undefined);
    if (handoff && !keep)
      await this.dispose(false);
  }

  private async dispatch(request: RunRequest) {
    const key = `${this.poolOptions.project.config.root}\0${request.context.files.map((file) => file.filepath).join()}`;
    const previous = handoffs.get(key);
    const next = Promise.withResolvers<VSCodePoolWorker | undefined>();
    handoffs.set(key, next.promise);
    this.handoff = next.resolve;

    try {
      const parked = await previous;

      if (parked && !parked.dead) {
        // Adopt its live extension host wholesale.
        this.ipc = parked.ipc;
        this.run = parked.run;
        this.server = parked.server;
        this.profilePath = parked.profilePath;
        this.ipc!.on('message', (message) => this.events.emit('message', message));
        this.ipc!.on('error', (error) => this.emitError(error));
        this.ipc!.on('close', () => {
          if (!this.stopping)
            this.events.emit('exit');
        });
      } else {
        await this.connect();
        this.run?.catch(() => undefined);

        // The extension host must complete its 'start' handshake before 'run'.
        const started = once(this.ipc!, 'message');
        this.ipc!.send(this.startMessage);
        const [reply] = await started;
        if (reply?.error)
          throw reply.error;
      }

      this.ipc!.send(request);
    } catch (error) {
      await this.dispose(true).catch(() => undefined);
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
