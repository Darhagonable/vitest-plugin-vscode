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
 * Watch-mode reuse: keep each test file's VS Code instance alive after its
 * run and hand it back when the same file reruns.
 *
 * Vitest creates a fresh PoolWorker per task (isolate: true) and reveals a
 * task's file paths only in the 'run'/'collect' request — its 'start'
 * request carries none. So this worker defers everything: messages are
 * buffered until the first run request names the files, then the parked
 * instance for exactly those files is adopted — or a new one is booted —
 * and the buffer is flushed in protocol order, awaiting the runtime's
 * real 'started' ack in between (the same ack vitest's runner awaits).
 * Instances are keyed by files, so a file always reruns in its own
 * extension host, never in another file's.
 *
 * Inbound messages route through the instance's `owner`, reassigned by
 * adoption — the connection's listeners are wired once, never moved.
 */

/** Subset of vitest's worker protocol messages this pool inspects. */
interface WorkerMessage {
  __vitest_worker_request__?: boolean;
  __vitest_worker_response__?: boolean;
  type?: string;
  context?: { files?: readonly { filepath: string }[] };
  error?: unknown;
}

/** A live VS Code instance, outliving the PoolWorker lifecycles it serves. */
interface VSCodeInstance {
  server: net.Server;
  ipc: LineIpc;
  run: Promise<number> | undefined;
  profilePath: string;
  /** Receives this instance's inbound messages; reassigned on adoption. */
  owner: VSCodePoolWorker | undefined;
}

/** Live instances parked by file key. */
const instances = new Map<string, VSCodeInstance>();

export async function shutdownWarmInstances(): Promise<void> {
  const parked = [...instances.values()];
  instances.clear();

  await Promise.all(parked.map(async (instance) => {
    instance.owner = undefined;
    instance.ipc.destroy();
    instance.server.close();

    try {
      await instance.run; // let VS Code exit before removing its profile
    }
    catch { /* an exit failure must not block cleanup */ }

    await rm(instance.profilePath, { recursive: true, force: true }).catch(() => undefined);
  }));
}

function filesKey(files: readonly { filepath: string }[]): string {
  return files.map(f => f.filepath).sort().join(',');
}

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private instance: VSCodeInstance | undefined;
  private stopping = false;
  private fileKey = '';
  private connecting: Promise<void> | undefined;
  private pending: unknown[] = [];
  // Set while connect() flushes the buffered 'start' and awaits the
  // runtime's real 'started' ack before forwarding the rest.
  private awaitingStarted: ReturnType<typeof Promise.withResolvers<void>> | undefined;

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
      // 'start' carries no files — buffer it and acknowledge immediately:
      // vitest sends the run request, the only carrier of the file paths,
      // only after this ack. The runtime's real ack flows on later
      // (harmlessly) and gates the paced flush in connect().
      if (msg.type === 'start') {
        this.pending.push(message);
        this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
        return;
      }

      // The run request names the files — it decides which instance to use.
      if ((msg.type === 'run' || msg.type === 'collect') && Array.isArray(msg.context?.files)) {
        this.fileKey = filesKey(msg.context.files);

        if (!this.instance && !this.connecting)
          this.connecting = this.connect();
      }

      // Acknowledge a stop that never had an instance to reach.
      if (msg.type === 'stop' && !this.instance && !this.connecting) {
        this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
        return;
      }
    }

    if (this.instance)
      this.instance.ipc.send(message);
    else
      this.pending.push(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // No-op: which VS Code instance to use is only known once the first run
    // request arrives (see send()). Everything happens lazily.
  }

  async stop() {
    await this.dispose(false);
  }

  private async connect(): Promise<void> {
    try {
      const parked = this.options.reuseWorker === false ? undefined : instances.get(this.fileKey);

      if (parked && !parked.ipc.closed) {
        instances.delete(this.fileKey);
        parked.owner = this;
        this.instance = parked;
      }
      else {
        if (parked) {
          // The parked instance died — release it before rebooting.
          instances.delete(this.fileKey);
          parked.owner = undefined;
          parked.ipc.destroy();
          parked.server.close();
          await rm(parked.profilePath, { recursive: true, force: true }).catch(() => undefined);
        }

        await this.coldBoot();
      }

      // Flush the buffer in protocol order. The runtime acks 'start'
      // asynchronously and accepts the run that follows only once done, so
      // the flush awaits that ack before forwarding the rest.
      const pending = this.pending;
      this.pending = [];
      const instance = this.instance!;

      const startIdx = pending.findIndex(
        m => (m as WorkerMessage)?.__vitest_worker_request__ === true && (m as WorkerMessage).type === 'start'
      );

      if (startIdx === -1) {
        for (const message of pending)
          instance.ipc.send(message);
        return;
      }

      for (let i = 0; i <= startIdx; i++)
        instance.ipc.send(pending[i]);

      const started = Promise.withResolvers<void>();
      this.awaitingStarted = started;
      try {
        await started.promise;
      }
      finally {
        this.awaitingStarted = undefined;
      }

      for (let i = startIdx + 1; i < pending.length; i++)
        instance.ipc.send(pending[i]);
    }
    catch (error) {
      this.pending = [];
      this.emitError(error);
    }
    finally {
      this.connecting = undefined;
    }
  }

  private async coldBoot() {
    const config = this.poolOptions.project.config;
    const { server, port, connected } = await this.createServer();

    // Anchor the download cache at the project root so nothing leaks outside
    // the package in monorepos. Per-worker profiles live in the OS temp dir:
    // short (unix socket path limits) and cleaned up on stop.
    const profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);

    // Per-worker user-data and extensions dirs go in first: concurrent VS Code
    // instances never share state and nothing lands at the CWD default.
    // Skipped under reuseMachineInstall, which runTests() also honors —
    // otherwise it would inject its own default profile dirs. User
    // launchArgs append last so they win by ordering.
    const launchArgs: string[] = [];

    if (!this.options.reuseMachineInstall) {
      launchArgs.push(
        `--extensions-dir=${path.join(profilePath, 'extensions')}`,
        `--user-data-dir=${path.join(profilePath, 'user-data')}`,
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

    const run = runTests({
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
    const exitedBeforeConnect = run.then(
      () => {
        if (!bridgeConnected)
          throw new Error('VS Code exited before the extension-host Vitest bridge connected.');
      },
      (error) => {
        if (!bridgeConnected)
          throw error;
      }
    );

    try {
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
    catch (error) {
      // A failed boot leaves nothing behind.
      this.instance?.ipc.destroy();
      server.close();
      await rm(profilePath, { recursive: true, force: true }).catch(() => undefined);
      this.instance = undefined;
      throw error;
    }

    const instance = this.instance!;
    instance.run = run;
    instance.profilePath = profilePath;

    run.catch((error) => {
      if (!this.stopping)
        this.emitError(error);
    });
  }

  private async dispose(hard: boolean) {
    this.stopping = true;

    if (this.connecting)
      await this.connecting;

    // Park this file's instance for its next run — VS Code stays alive.
    // Vitest does not await runner teardown before scheduling the next
    // task, so same-file workers can overlap: only the first parks.
    const instance = this.instance;
    if (!hard && this.options.reuseWorker !== false && instance && this.fileKey && !instances.has(this.fileKey)) {
      instance.owner = undefined;
      instance.server.unref();
      instance.ipc.unref();
      instances.set(this.fileKey, instance);

      this.instance = undefined;
      this.fileKey = '';
      this.stopping = false;
      return;
    }

    try {
      if (hard) {
        instance?.ipc.destroy();
      }
      else {
        instance?.ipc.close();
        // No timeout: vitest's own teardownTimeout bounds the whole pool.
        await instance?.run?.then(undefined, (error) => {
          if (!(error instanceof TestRunFailedError))
            throw error;
        });
      }

      instance?.server.close();
    } finally {
      if (instance) {
        instance.owner = undefined;
        this.instance = undefined;
      }

      this.stopping = false;

      if (instance?.profilePath) {
        await rm(instance.profilePath, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  canReuse() {
    // Always false: reuse is routed by file key through parked instances, so
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
      const ipc = new LineIpc(socket);
      const instance: VSCodeInstance = {
        server,
        ipc,
        run: undefined,
        profilePath: '',
        owner: this
      };
      this.instance = instance;

      // Wired once per connection: inbound messages route to the
      // instance's current owner (reassigned by adoption), never moved.
      ipc.on('message', (message) => {
        const owner = instance.owner;
        if (!owner)
          return;

        const msg = message as WorkerMessage;
        if (owner.awaitingStarted && msg?.__vitest_worker_response__ === true && msg.type === 'started') {
          if (msg.error !== undefined)
            owner.awaitingStarted.reject(msg.error);
          else
            owner.awaitingStarted.resolve();
        }

        owner.events.emit('message', message);
      });
      ipc.on('error', (error) => instance.owner?.emitError(error));
      ipc.on('close', () => {
        const owner = instance.owner;
        if (owner && !owner.stopping)
          owner.events.emit('exit');
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
