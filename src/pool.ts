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
  ) {
    // A listenerless 'error' emit would throw inside the pool process.
    this.events.on('error', () => {});
  }

  on(event: string, callback: (arg: unknown) => void) {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.events.off(event, callback);
  }

  send(message: unknown) {
    const request = message as { type?: string; __vitest_worker_request__?: boolean; context?: { files?: { filepath: string }[] } };

    // Answer the start handshake in place of the extension host: the file is
    // only named by the run request that follows it.
    if (request?.__vitest_worker_request__ === true && request.type === 'start') {
      this.startRequest = message;
      this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
      return;
    }

    if ((request?.type === 'run' || request?.type === 'collect') && !this.file) {
      const file = this.file = request.context?.files?.[0]?.filepath;
      const parked = file ? hosts.get(file) : undefined;
      hosts.delete(file!);
      const host = parked ?? new VSCodeHost(this.poolOptions, this.options);
      this.host = host;
      void this.runSession(host, message, !parked);
      return;
    }

    if (!this.ipc) {
      this.events.emit('error', new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // Connect lazily from send(): the run request names this task's file.
  }

  async stop() {
    const { host, ipc } = this;
    // Park cleanly finished instances for this file's next run, watch mode only.
    if (host && ipc && this.clean && this.file && this.options.reuseWorker !== false && this.poolOptions.project.config.watch) {
      hosts.set(this.file, host);
      // If the socket later closes (a crash), drop the instance so the next
      // run boots fresh. Teardown empties the map first, so no double-dispose.
      ipc.once('close', () => {
        if (hosts.delete(this.file!))
          void host.dispose();
      });
    } else {
      await host?.dispose();
    }
  }

  private async runSession(host: VSCodeHost, request: unknown, fresh: boolean) {
    try {
      if (fresh)
        await host.connect();

      // The socket outlives each task; reruns keep adding wiring to it.
      const ipc = host.ipc!;
      ipc.setMaxListeners(0);
      this.ipc = ipc;
      let started: (error: unknown) => void = () => {};      ipc.on('message', (message: unknown) => {
        const { type, error } = message as { type?: string; error?: unknown };
        if (type === 'stopped')
          this.clean = true;
        if (type === 'started')
          started(error);
        this.events.emit('message', message);
      });
      ipc.on('error', (error) => this.events.emit('error', error));
      ipc.on('close', () => this.events.emit('exit'));

      // Replay "start" and await the real "started" reply before the run
      // request: the extension host handles both concurrently.
      ipc.send(this.startRequest);
      await new Promise((resolve, reject) => (started = (error) => error === undefined ? resolve(null) : reject(error)));
      ipc.send(request);
    } catch (error) {
      hosts.delete(this.file!);
      this.events.emit('error', error);
    }
  }
}

export class VSCodeHost {
  private server: net.Server | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  ipc: LineIpc | undefined;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  async connect() {
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

  async dispose() {
    this.ipc?.destroy();
    this.server?.close();

    try {
      if (this.run) {
        // No timeout: vitest's own teardownTimeout bounds the whole pool.
        await this.run?.then(undefined, (error) => {
          if (!(error instanceof TestRunFailedError))
            throw error;
        });
      }
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
    });

    return {
      server,
      port: address.port,
      connected: once(server, 'connection')
    };
  }
}
