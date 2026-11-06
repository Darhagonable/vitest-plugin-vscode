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

export const hosts = new Map<string, VSCodeHost>();

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private host: VSCodeHost | undefined;
  private ipc: LineIpc | undefined;
  private file: string | undefined;
  private startRequest: unknown;
  private clean = false;

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

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // Connect lazily from send(): the file this task runs is only named by
    // the run request, which vitest sends after a "started" reply.
  }

  send(message: unknown) {
    const request = message as { type?: string; __vitest_worker_request__?: boolean };

    // Answer the start handshake in place of the extension host: the file
    // this task runs is only named by the run request that follows it.
    if (request?.__vitest_worker_request__ === true && request.type === 'start') {
      this.startRequest = message;
      this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
      return;
    }

    // A runner kept alive by `isolate: false` reuses its open session.
    if ((request?.type === 'run' || request?.type === 'collect') && !this.file) {
      this.openSession(message);
      return;
    }

    if (!this.ipc) {
      this.emitError(new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
  }

  async stop() {
    const host = this.host;
    this.host = undefined;
    this.ipc?.close();

    // Park cleanly finished instances for this file's next run, in watch
    // mode only; anything else retires them.
    if (host && this.clean && this.file && this.options.reuseWorker !== false && this.poolOptions.project.config.watch) {
      hosts.set(this.file, host);
    } else {
      await host?.dispose();
    }
  }

  private openSession(request: unknown) {
    const file = (request as { context?: { files?: { filepath: string }[] } }).context?.files?.[0]?.filepath;
    this.file = file;
    const parked = file ? hosts.get(file) : undefined;
    hosts.delete(file!);
    const host = parked ?? new VSCodeHost(this.poolOptions, this.options);
    this.host = host;
    void this.runSession(host, request, !parked);
  }

  private async runSession(host: VSCodeHost, request: unknown, fresh: boolean) {
    try {
      if (fresh)
        await host.connect();

      const ipc = await host.nextSession();

      this.ipc = ipc;
      ipc.on('message', (message: unknown) => {
        if ((message as { type?: string })?.type === 'stopped')
          this.clean = true;
        this.events.emit('message', message);
      });
      ipc.on('error', (error) => this.emitError(error));
      ipc.on('close', () => this.events.emit('exit'));

      // Replay "start" and await the real "started" reply before the run
      // request: the extension host handles both concurrently.
      ipc.send(this.startRequest);
      await new Promise((resolve, reject) => {
        const onMessage = (message: { type?: string; error?: unknown }) => {
          if (message?.type !== 'started')
            return;
          ipc.off('message', onMessage);
          message.error === undefined ? resolve(null) : reject(message.error);
        };
        ipc.on('message', onMessage);
      });
      ipc.send(request);
    } catch (error) {
      hosts.delete(this.file!);
      this.emitError(error);
    }
  }

  private emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}

/** A VS Code instance kept alive for the reruns of a single test file. */
export class VSCodeHost {
  private readonly sessions = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  async connect() {
    const { server, port } = await this.createServer();
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
  }

  /** Claim the next session socket; rejects when VS Code exits first. */
  async nextSession(): Promise<LineIpc> {
    if (!this.ipc) {
      const timeout = this.poolOptions.project.config.inspector.waitForDebugger ? 300_000 : 30_000;

      await Promise.race([
        once(this.sessions, 'session'),
        this.run!.then(() => { throw new Error('The VS Code extension host exited.'); }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for the VS Code extension-host Vitest bridge to connect.')), timeout).unref())
      ]);
    }

    const ipc = this.ipc!;
    this.ipc = undefined;
    return ipc;
  }

  async dispose() {
    this.ipc?.destroy();
    this.server?.close();

    try {
      // No timeout: vitest's own teardownTimeout bounds the whole pool.
      await this.run?.then(undefined, (error) => {
        if (!(error instanceof TestRunFailedError))
          throw error;
      });
    } finally {
      if (this.profilePath) {
        await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
        this.profilePath = undefined;
      }
    }
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
      this.sessions.emit('session', this.ipc);
    });

    return { server, port: address.port };
  }
}
