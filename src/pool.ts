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

const warmHosts = new Map<string, VSCodePoolWorker>();
/** Every booted host, for teardown when the Vite server closes. */
const liveHosts = new Set<VSCodePoolWorker>();

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private key = '';
  private host: VSCodePoolWorker | undefined;
  private buffered: unknown[] = [];
  private finished = false;
  private stopped = false;

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
    if ((message as WorkerRequest).__vitest_worker_request__) {
      switch ((message as WorkerRequest).type) {
        // answered locally; replayed to the host once one is adopted
        case 'start':
          this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
          this.buffered.push(message);
          return;
        // never forwarded: the host must outlive this task's worker
        case 'stop':
          this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
          return;
        case 'run':
        case 'collect':
          this.bind(message as Extract<WorkerRequest, { type: 'run' | 'collect' }>).catch((error) => {
            void this.host?.dispose(true);
            this.emitError(error);
          });
          return;
      }
    }

    if (this.host)
      this.host.ipc?.send(message);
    else
      this.buffered.push(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {}

  async stop() {
    this.stopped = true;
    const host = this.host;
    this.host = undefined;
    if (!host || host.stopping)
      return;

    if (this.finished && this.options.reuseWorker !== false && this.poolOptions.project.config.watch)
      warmHosts.set(host.key, host);
    else
      await host.dispose(!this.finished);
  }

  private async bind(runRequest: Extract<WorkerRequest, { type: 'run' | 'collect' }>) {
    const key = `${this.poolOptions.project.name}|${runRequest.context.files.map((file) => file.filepath)}`;
    const host = this.host = warmHosts.get(key) ?? new VSCodePoolWorker(this.poolOptions, this.options);
    warmHosts.delete(key);
    this.finished = false;

    if (!host.ipc) {
      await host.connect();
      liveHosts.add(host);
    }

    host.key = key;
    host.events.on('message', (message) => {
      if ((message as { type?: string }).type === 'testfileFinished')
        this.finished = true;
      this.events.emit('message', message);
    });
    host.events.on('error', (error) => this.emitError(error));
    host.events.on('exit', () => {
      if (!this.stopped)
        this.events.emit('exit');
    });

    for (const buffered of this.buffered)
      host.ipc?.send(buffered);
    this.buffered = [];

    // the host's genuine "started" reply orders its async start handling
    // before the run; the local ack in send() cannot
    await new Promise<void>((resolve, reject) => {
      const onStarted = (message: { type?: string; error?: unknown }) => {
        if (message?.type !== 'started')
          return;
        host.events.off('message', onStarted);
        message.error ? reject(message.error) : resolve();
      };
      host.events.on('message', onStarted);
      host.events.once('exit', () => reject(new Error('The extension host exited before accepting a run.')));
    });

    host.ipc?.send(runRequest);
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
    // a late rejection (a disposed host) must not surface as unhandled
    this.run.catch(() => {});
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
        warmHosts.delete(this.key);
        if (!this.stopping) {
          void this.dispose(true);
          this.events.emit('exit');
        }
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

/** Reap every host; the plugin calls this when the Vite server closes. */
export async function disposeAllHosts() {
  await Promise.all([...liveHosts].map((host) => host.dispose(false)));
}
