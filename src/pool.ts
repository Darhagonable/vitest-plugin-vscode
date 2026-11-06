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

/*
 * Watch-mode reuse: vitest reveals a task's file paths only in 'run'/'collect'
 * messages — its 'start' message carries none and is acked before 'run' is
 * even sent. So the worker defers connecting: 'start' is buffered and acked
 * here, and the first run request adopts this file's parked VS Code instance
 * from the map below — or cold boots a new one. Instances are keyed by their
 * files, so a file always reruns in its own extension host, never in another
 * file's. Works with the default isolate: true.
 */

/** Subset of vitest's worker protocol messages this pool inspects. */
interface WorkerMessage {
  __vitest_worker_request__?: boolean;
  __vitest_worker_response__?: boolean;
  type?: string;
  context?: { files?: readonly { filepath: string }[] };
  error?: unknown;
}

interface WarmConnection {
  filesKey: string;
  server: net.Server;
  ipc: LineIpc;
  run: Promise<number>;
  profilePath: string;
}

/*
 * Live VS Code instances parked by file key, outliving PoolWorker lifecycles.
 * shutdownWarmConnections() — called from the plugin's closeServer hook — is
 * the cleanup; destroying the IPC is the exit signal for the instance.
 */
const warmConnections = new Map<string, WarmConnection>();

export async function shutdownWarmConnections(): Promise<void> {
  const connections = [...warmConnections.values()];
  warmConnections.clear();

  await Promise.all(connections.map(async (conn) => {
    conn.ipc.destroy();
    conn.server.close();

    try {
      await conn.run; // let VS Code exit before removing its profile
    }
    catch { /* an exit failure must not block cleanup */ }

    await rm(conn.profilePath, { recursive: true, force: true }).catch(() => undefined);
  }));
}

function filesKey(files: readonly { filepath: string }[]): string {
  return files.map(f => f.filepath).sort().join(',');
}

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private fileKey = '';
  private connecting: Promise<void> | undefined;
  private pending: unknown[] = [];
  // Set only while connect() awaits the worker's 'started' ack to pace the
  // buffered flush; resolved from the message handler in wireIpcEvents().
  private resolveBridgeStarted?: () => void;
  private rejectBridgeStarted?: (reason?: unknown) => void;

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
    const msg = message as WorkerMessage;

    if (msg?.__vitest_worker_request__ === true) {
      // 'start' carries no files — buffer it and acknowledge immediately, so
      // vitest sends the run request that reveals which instance to use.
      if (msg.type === 'start') {
        this.pending.push(message);
        this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
        return;
      }

      if ((msg.type === 'run' || msg.type === 'collect') && Array.isArray(msg.context?.files)) {
        this.fileKey = filesKey(msg.context.files);

        if (!this.ipc && !this.connecting)
          this.connecting = this.connect();
      }

      // Acknowledge a stop that never had a bridge to reach it.
      if (msg.type === 'stop' && !this.ipc && !this.connecting) {
        this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
        return;
      }
    }

    if (this.ipc)
      this.ipc.send(message);
    else
      this.pending.push(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // No-op: which VS Code instance to use is only known once the first run
    // request arrives (see send()). Everything below happens lazily.
  }

  async stop() {
    await this.dispose(false);
  }

  private async connect(): Promise<void> {
    try {
      const parked = this.options.reuseWorker === false ? undefined : warmConnections.get(this.fileKey);

      if (parked && !parked.ipc.closed) {
        warmConnections.delete(this.fileKey);
        this.adopt(parked);
      }
      else {
        if (parked) {
          // The parked instance died — release it before rebooting.
          warmConnections.delete(this.fileKey);
          parked.server.close();
          parked.ipc.destroy();
          await rm(parked.profilePath, { recursive: true, force: true }).catch(() => undefined);
        }

        await this.coldBoot();
      }

      // Restore vitest's natural request/response pacing: the worker runtime
      // handles 'start' asynchronously and only accepts 'run' once finished,
      // so the buffered batch is flushed around its ack.
      const pending = this.pending;
      this.pending = [];

      const startIdx = pending.findIndex(
        m => (m as WorkerMessage)?.__vitest_worker_request__ === true && (m as WorkerMessage).type === 'start'
      );

      if (startIdx === -1) {
        for (const message of pending)
          this.ipc!.send(message);
      }
      else {
        const { promise: bridgeStarted, resolve, reject } = Promise.withResolvers<void>();
        this.resolveBridgeStarted = resolve;
        this.rejectBridgeStarted = reject;

        for (let i = 0; i <= startIdx; i++)
          this.ipc!.send(pending[i]);

        try {
          await bridgeStarted;
        }
        finally {
          this.resolveBridgeStarted = undefined;
          this.rejectBridgeStarted = undefined;
        }

        for (let i = startIdx + 1; i < pending.length; i++)
          this.ipc!.send(pending[i]);
      }
    }
    catch (error) {
      this.pending = [];
      this.emitError(error);
    }
    finally {
      this.connecting = undefined;
    }
  }

  private adopt(parked: WarmConnection): void {
    this.server = parked.server;
    this.ipc = parked.ipc;
    this.run = parked.run;
    this.profilePath = parked.profilePath;
    this.fileKey = parked.filesKey;

    try {
      parked.server.ref();
    }
    catch { /* already closed */ }
    this.ipc.ref();

    this.ipc.removeAllListeners();
    this.wireIpcEvents();
  }

  private async coldBoot() {
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
    ]).catch(async (error) => {
      // A failed boot leaves nothing behind.
      this.ipc?.destroy();
      this.server?.close();

      if (this.profilePath) {
        await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
        this.profilePath = undefined;
      }

      this.ipc = undefined;
      this.server = undefined;
      this.run = undefined;
      throw error;
    });

    this.run.catch((error) => {
      if (!this.stopping)
        this.emitError(error);
    });
  }

  private async dispose(hard: boolean) {
    this.stopping = true;

    if (this.connecting)
      await this.connecting;

    // Park the connection for the next run of these files — VS Code stays
    // alive. Vitest does not await runner teardown before scheduling the
    // next task, so same-file workers can overlap: only the first parks.
    if (!hard && this.options.reuseWorker !== false && this.ipc && this.server && this.run
      && this.profilePath && this.fileKey && !warmConnections.has(this.fileKey)) {
      this.server.unref();
      this.ipc.unref();

      warmConnections.set(this.fileKey, {
        filesKey: this.fileKey,
        server: this.server,
        ipc: this.ipc,
        run: this.run,
        profilePath: this.profilePath
      });

      this.ipc = undefined;
      this.server = undefined;
      this.run = undefined;
      this.profilePath = undefined;
      this.fileKey = '';
      this.stopping = false;
      return;
    }

    try {
      if (hard) {
        this.ipc?.destroy();
      }
      else {
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
    // Always false: reuse is routed by file key through warmConnections, so
    // vitest never sends another file's run request over this connection.
    return false;
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
      this.wireIpcEvents();
    });

    return {
      server,
      port: address.port,
      connected: once(server, 'connection')
    };
  }

  /*
   * Wire IPC events to this worker. Called on cold boot (from createServer)
   * and on warm adopt (from adopt).
   */
  private wireIpcEvents(): void {
    this.ipc!.on('message', (message) => {
      // The worker acks 'start' after our synthetic ack already unblocked
      // vitest, so the duplicate flows on harmlessly; it gates the paced
      // flush in connect(). A failing ack is escalated as a worker error.
      const msg = message as WorkerMessage;

      if (this.resolveBridgeStarted && msg?.__vitest_worker_response__ === true && msg.type === 'started') {
        if (msg.error !== undefined) {
          this.rejectBridgeStarted?.(msg.error);
          this.emitError(msg.error);
        }
        else {
          this.resolveBridgeStarted();
        }
      }

      this.events.emit('message', message);
    });
    this.ipc!.on('error', (error) => this.emitError(error));
    this.ipc!.on('close', () => {
      if (!this.stopping)
        this.events.emit('exit');
    });
  }

  private emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}
