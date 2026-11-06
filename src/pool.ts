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

// Warm extension hosts parked between watch reruns, keyed by project + files.
export const hosts = new Map<string, ExtensionHost>();

/** One live VS Code extension host; `events` is retargeted to its owner. */
class ExtensionHost {
  private server?: net.Server;
  private ipc?: LineIpc;
  private run?: Promise<number>;
  private profilePath: string | undefined;
  private stopping = false;
  events = new EventEmitter();
  private resolveStarted: (() => void) | undefined;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  async start(start: unknown) {
    if (this.ipc)
      return this.handshake(start);

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

    return this.handshake(start);
  }

  /** Replay the held start request; its reply orders what comes after it. */
  private handshake(start: unknown) {
    return new Promise<void>((resolve) => ((this.resolveStarted = resolve), this.send(start)));
  }

  send(message: unknown) {
    if (!this.ipc) {
      this.emitError(new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
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
      this.ipc.on('message', (message) => {
        if ((message as { type?: string }).type === 'started') this.resolveStarted?.();
        this.events.emit('message', message);
      });
      this.ipc.on('error', (error) => this.emitError(error));
      // A closed bridge is never reused: clear it so a later start() cold-boots a fresh one.
      this.ipc.on('close', () => {
        this.ipc = undefined, this.server?.close();
        this.resolveStarted?.();
        this.profilePath && rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
        this.profilePath = undefined;

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

  emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}

/**
 * The pool worker: a per-task face answering vitest's start/stop handshakes
 * itself (files only arrive with the run request, after the handshake),
 * adopting — or booting — the host keyed by exactly those files. */
export function createPoolWorker(poolOptions: PoolOptions, options: VSCodeOptions): PoolWorker {
  const events = new EventEmitter();
  let host: ExtensionHost | undefined, startMessage: unknown, key = '', stopped = false;

  return {
    name: 'vscodePool',
    on: (event: string, callback: (arg: unknown) => void) => events.on(event, callback),
    off: (event: string, callback: (arg: unknown) => void) => events.off(event, callback),
    deserialize: (data: unknown) => data,
    async start() {},
    send(message: WorkerRequest) {
      if (host) {
        // Recycling the worker must not kill a warm host: answer its stop handshake for it.
        if (message.__vitest_worker_request__ && message.type === 'stop')
          return void events.emit('message', { type: 'stopped', __vitest_worker_response__: true });

        return host.send(message);
      }

      // The run request is the only message naming the files: hold it and the
      // handshake for the adopted host.
      if (message.__vitest_worker_request__ && message.type === 'start') {
        startMessage = message;
        return void events.emit('message', { type: 'started', __vitest_worker_response__: true });
      }

      if (message.__vitest_worker_request__ && (message.type === 'run' || message.type === 'collect')) {
        key = `${poolOptions.project.name}\n${message.context.files.map(file => file.filepath).join('\n')}`;
        host = hosts.get(key) ?? new ExtensionHost(poolOptions, options);
        host.events = events;

        host.start(startMessage).then(
          () => !stopped && host?.send(message),
          error => host?.emitError(error)
        );
      }
    },
    async stop() {
      stopped = true;
      const owned = host;
      if (!owned)
        return; // still booting: stop() raced the run request, nothing to park

      // Watch reruns reuse their file's warm host; other runs keep cold teardown.
      if (poolOptions.project.config.watch && options.reuseWorker !== false)
        hosts.set(key, owned);
      else
        await owned.dispose(false);
    }
  };
}
