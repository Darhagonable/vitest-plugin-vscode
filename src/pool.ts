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

type PoolRequest = {
  __vitest_worker_request__?: boolean;
  type?: string;
  context?: { files?: { filepath: string }[] };
};

// Parked extension hosts (issue #3), keyed by project + test files. With
// isolate: true vitest discards the pool worker after every task, so the
// worker that booted a VS Code instance stays registered here and later
// tasks for the same files forward through it instead of cold-booting.
const hosts = new Map<string, VSCodePoolWorker>();

function hostKey(poolOptions: PoolOptions, request: PoolRequest): string {
  const files = (request.context?.files ?? []).map((file) => file.filepath).sort();
  return JSON.stringify([poolOptions.project.name, ...files]);
}

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  /** Set when the bridge closed: never adopt a dead host again. */
  dead = false;
  private host: VSCodePoolWorker | undefined;
  // The start handshake arrives before the run request names the files, so
  // it is held and replayed to the matching host once they are known.
  private startMessage: unknown;

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
    const request = message as PoolRequest;

    if (!this.host && request?.__vitest_worker_request__) {
      switch (request.type) {
        case 'start':
          // Only the run/collect request carries the files, so vitest's
          // handshake is answered here and the real one is replayed to the
          // matching host once they are known; vitest would block until then.
          this.startMessage = message;
          this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
          return;
        case 'run':
        case 'collect':
          void this.acquire(message);
          return;
        case 'stop':
          // Cancelled before any host was bound: nothing to tear down.
          this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
          return;
      }
    }

    this.host === this ? this.ipc?.send(message) : this.host?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // Nothing to connect to yet: the host is chosen by the files of the run
    // request, which vitest only sends after this handshake.
  }

  async stop() {
    // Park: the host stays registered for the next run of the same files.
    // Cold-boot mode (reuseWorker: false) tears its own host down instead.
    if (this.host === this && this.options.reuseWorker === false)
      await this.dispose(false);
  }

  private async acquire(message: unknown) {
    const key = hostKey(this.poolOptions, message as PoolRequest);

    try {
      let host = hosts.get(key);

      if (!host || host.dead) {
        hosts.set(key, (host = this));
        await this.connect();
      }

      this.host = host;

      if (host !== this) {
        // Forward a parked host's bridge traffic to this task's runner.
        host.on('message', (m) => this.events.emit('message', m));
        host.on('exit', () => this.events.emit('exit'));
        host.on('error', (e) => this.emitError(e));
      }

      // The run request must not overtake the (asynchronous) worker-side
      // setup inside the extension host.
      const started = new Promise<void>((resolve) => {
        const on = (m: PoolRequest) => {
          if (m?.type === 'started') {
            this.events.off('message', on);
            resolve();
          }
        };
        this.events.on('message', on);
      });

      this.send(this.startMessage);
      this.startMessage = undefined;
      await Promise.race([
        started,
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Timed out waiting for the extension-host Vitest worker to start.'));
          }, 30_000).unref();
        })
      ]);
      this.send(message);
    } catch (error) {
      if (hosts.get(key) === this) {
        hosts.delete(key);
        await this.dispose(true);
      }
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
    this.dead = true;

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
        if (!this.stopping) {
          this.events.emit('exit');
          // A host that died on its own is no longer adoptable; release its
          // server and profile here, before it gets replaced in the registry.
          void this.dispose(true);
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

/** Tears down every parked instance; wired to the vite closeServer hook. */
export async function disposeHosts() {
  const warm = [...hosts.values()];
  hosts.clear();
  await Promise.all(warm.map((host) => host.dispose(false)));
}
