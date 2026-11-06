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
const hosts = new Map<string, ExtensionHost>();

/** Tear down every warm host; wired to the plugin's vite closeServer hook. */
export async function disposeHosts(): Promise<void> {
  const warm = [...hosts.values()];
  hosts.clear();
  await Promise.all(warm.map(host => host.dispose(false)));
}

class ExtensionHost {
  private server?: net.Server;
  private ipc?: LineIpc;
  private run?: Promise<number>;
  private profilePath: string | undefined;
  private stopping = false;
  dead = false;
  sink?: EventEmitter;
  private resolveStarted: (() => void) | undefined;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  /** Boot if needed, then replay vitest's held start request; its 'started'
   * reply (or the bridge closing) orders the run request after the worker's
   * asynchronous handling of 'start'. */
  async start(start: unknown) {
    const started = new Promise<void>((resolve) => (this.resolveStarted = resolve));

    if (!this.ipc) {
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

    this.send(start);
    await started;
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
        if ((message as { type?: string }).type === 'started')
          this.resolveStarted?.();
        this.sink?.emit('message', message);
      });
      this.ipc.on('error', (error) => this.emitError(error));
      this.ipc.on('close', () => {
        this.dead = true;
        this.resolveStarted?.();
        if (this.stopping) return;
        if (this.sink) this.sink.emit('exit');
        // died while warm: nobody owns it, so clean it up here
        else this.dispose(false).catch(() => undefined);
      });
    });

    return {
      server,
      port: address.port,
      connected: once(server, 'connection')
    };
  }

  emitError(error: unknown) {
    const { sink } = this;
    if (sink && sink.listenerCount('error') > 0)
      sink.emit('error', error);
  }
}

/**
 * The pool worker vitest talks to. With isolate: true vitest only names the
 * task's files with the run request — after the start handshake — so this proxy
 * answers both handshakes itself and adopts (or boots) the host for exactly
 * those files, replaying what it held.
 */
export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private startMessage: WorkerRequest | undefined;
  private host: ExtensionHost | undefined;
  private key: string | undefined;
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

  send(message: WorkerRequest) {
    if (this.host) {
      // Recycling the worker must not kill a warm host: answer the stop handshake for it.
      if (message.__vitest_worker_request__ && message.type === 'stop')
        return void this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });

      return this.host.send(message);
    }

    // The run request is the only message naming the files, and it comes only
    // after the handshake: answer locally and hold the message.
    if (message.__vitest_worker_request__ && message.type === 'start') {
      this.startMessage = message;
      return void this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
    }

    if (message.__vitest_worker_request__ && (message.type === 'run' || message.type === 'collect'))
      this.adopt(message.context.files, message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // Nothing to boot yet: the host is chosen by the run request's files.
  }

  async stop() {
    this.stopped = true;
    const host = this.host;
    this.host = undefined;

    if (!host)
      return; // still booting: the adopt continuation disposes it

    host.sink = undefined;

    // Watch reruns reuse their file's warm host; other runs keep cold teardown.
    if (this.poolOptions.project.config.watch && this.options.reuseWorker !== false && !host.dead)
      hosts.set(this.key!, host);
    else
      await host.dispose(false);
  }

  private adopt(files: { filepath: string }[], request: WorkerRequest) {
    this.key = `${this.poolOptions.project.name}\n${files.map(file => file.filepath).join('\n')}`;

    const warm = hosts.get(this.key);
    const host = warm && !warm.dead ? warm : new ExtensionHost(this.poolOptions, this.options);
    host.sink = this.events;

    host.start(this.startMessage).then(
      () => {
        if (this.stopped)
          return host.dispose(false);

        this.host = host;
        this.send(request);
      },
      (error) => host.emitError(error)
    );
  }
}
