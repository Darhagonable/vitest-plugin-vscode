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

/** The run/collect request: the only message naming which files to test. */
interface RunRequest {
  readonly context: { files: { filepath: string }[] };
}

/** A live VS Code extension host, pinned to a single set of test files. */
interface HostInstance {
  readonly server: net.Server;
  ipc: LineIpc | undefined;
  run: Promise<number>;
  readonly profilePath: string;
  /** Completed the extension-host 'start' handshake; its run context is live. */
  started: boolean;
  /** The bridge or VS Code itself died; dispose instead of reusing. */
  closed: boolean;
}

/** Ownership of the extension host pinned to one key (project + files). */
interface InstanceClaim {
  readonly instance: Promise<HostInstance>;
  /** Pass the instance to the next task, or undefined to force a cold boot. */
  readonly handoff: (instance: HostInstance | undefined) => void;
}

/** Kill a VS Code instance and remove its temporary profile. */
async function disposeInstance(instance: HostInstance, hard = false) {
  const wasClosed = instance.closed;
  instance.closed = true;

  try {
    if (!wasClosed)
      hard ? instance.ipc?.destroy() : instance.ipc?.close();
    // No timeout: vitest's own teardownTimeout bounds the whole pool.
    if (!hard) {
      await instance.run.then(undefined, (error) => {
        if (!(error instanceof TestRunFailedError))
          throw error;
      });
    }
  } finally {
    instance.server.close();
    await rm(instance.profilePath, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Keeps VS Code instances warm between watch-mode tasks. Vitest creates a
 * fresh pool worker per task (isolate: true), so instances are handed off
 * through a per-key promise chain: the next task for a key adopts the
 * instance its predecessor parked. A file therefore always reruns in its own
 * extension host and never in another file's.
 */
export class WarmInstances {
  private readonly handoffs = new Map<string, Promise<HostInstance | undefined>>();
  private readonly live = new Set<HostInstance>();

  /** Take ownership of the instance for `key`, booting one if none is parked. */
  acquire(key: string, boot: () => Promise<HostInstance>): InstanceClaim {
    const previous = this.handoffs.get(key);
    const handoff = Promise.withResolvers<HostInstance | undefined>();
    this.handoffs.set(key, handoff.promise);

    return {
      handoff: handoff.resolve,
      instance: (async () => {
        const parked = await previous;
        const instance = parked && !parked.closed ? parked : await boot();
        this.live.add(instance);
        return instance;
      })()
    };
  }

  /** Dispose every tracked instance; called when the Vite server closes. */
  async flush() {
    const instances = [...this.live];
    this.live.clear();
    await Promise.all(instances.map((instance) => disposeInstance(instance).catch(() => undefined)));
  }
}

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private claim: InstanceClaim | undefined;
  private instance: HostInstance | undefined;
  private startMessage: unknown;
  private finished = false;
  private onMessage: ((message: unknown) => void) | undefined;
  private onExit: (() => void) | undefined;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly warm: WarmInstances
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
      // Which extension host this worker belongs to is only revealed by the
      // run request's files, which vitest sends after this reply. Acknowledge
      // now; the real handshake happens once the files are known.
      this.startMessage = message;
      this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
      return;
    }

    if (type === 'run' || type === 'collect') {
      void this.dispatch(message as RunRequest);
      return;
    }

    if (type === 'stop') {
      // Keep the extension host warm: no teardown between runs of the same
      // instance, exactly like vitest's own shared (isolate: false) runners.
      this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
      return;
    }

    // Parent-side rpc replies and cancellation for the run in flight.
    this.instance?.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // Nothing to do: the extension host is adopted on the run request.
  }

  async stop() {
    this.unlisten();

    const claim = this.claim;
    this.claim = undefined;

    if (!claim)
      return;

    try {
      const instance = await claim.instance;
      const keep = this.options.reuseWorker !== false
        && this.poolOptions.project.config.watch
        && this.finished
        && !instance.closed;
      claim.handoff(keep ? instance : undefined);
      if (!keep)
        await disposeInstance(instance);
    } catch {
      // Cold boot failed: connect() already cleaned up after itself.
      claim.handoff(undefined);
    }
  }

  canReuse() {
    return this.options.reuseWorker !== false;
  }

  private async dispatch(request: RunRequest) {
    const config = this.poolOptions.project.config;

    try {
      // One extension host per project and set of files, never shared.
      const key = `${config.root}\0${request.context.files.map((file) => file.filepath).join()}`;
      const claim = this.warm.acquire(key, () => this.connect());
      this.claim = claim;

      const instance = await claim.instance;
      this.adopt(instance);

      if (!instance.started) {
        // Cold boot: initialize the extension host's run context before the
        // run request, which would otherwise race the async 'start' handler.
        const ipc = instance.ipc!;
        const started = once(ipc, 'message');
        ipc.send(this.startMessage);
        const [reply] = await started;
        if (reply?.type !== 'started' || reply.error)
          throw reply.error ?? new Error('VS Code extension host did not start.');
        instance.started = true;
      }

      instance.ipc!.send(request);
    } catch (error) {
      this.emitError(error);
    }
  }

  private adopt(instance: HostInstance) {
    this.instance = instance;
    this.onMessage = (message) => {
      if ((message as { type?: string })?.type === 'testfileFinished')
        this.finished = true;
      this.events.emit('message', message);
    };
    this.onExit = () => {
      // Only while the run is ours: stop() detaches before parking/disposing.
      if (this.claim)
        this.events.emit('exit');
    };
    instance.ipc?.on('message', this.onMessage);
    instance.ipc?.on('close', this.onExit);
  }

  private unlisten() {
    const ipc = this.instance?.ipc;
    if (ipc && this.onMessage)
      ipc.off('message', this.onMessage);
    if (ipc && this.onExit)
      ipc.off('close', this.onExit);
  }

  private async connect(): Promise<HostInstance> {
    const { server, port, connected } = await this.createServer();

    const instance: HostInstance = {
      server,
      ipc: undefined,
      run: Promise.resolve(0),
      profilePath: path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`),
      started: false,
      closed: false
    };

    try {
      // Anchor the download cache at the project root so nothing leaks outside
      // the package in monorepos. Per-worker profiles live in the OS temp dir:
      // short (unix socket path limits) and cleaned up on stop.
      const config = this.poolOptions.project.config;

      // Per-worker user-data and extensions dirs go in first: concurrent VS Code
      // instances never share state and nothing lands at the CWD default.
      // Skipped under reuseMachineInstall, which runTests() also honors —
      // otherwise it would inject its own default profile dirs. User
      // launchArgs append last so they win by ordering.
      const launchArgs: string[] = [];

      if (!this.options.reuseMachineInstall) {
        launchArgs.push(
          `--extensions-dir=${path.join(instance.profilePath, 'extensions')}`,
          `--user-data-dir=${path.join(instance.profilePath, 'user-data')}`,
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

      instance.run = runTests({
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
      instance.run.catch(() => undefined);

      let bridgeConnected = false;
      const connectedBeforeExit = connected.then(([socket]) => {
        bridgeConnected = true;
        instance.ipc = new LineIpc(socket);
        // A parked instance that dies must never be adopted again.
        instance.ipc.on('close', () => (instance.closed = true));
        instance.ipc.on('error', () => (instance.closed = true));
      });
      const exitedBeforeConnect = instance.run.then(
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
    } catch (error) {
      await disposeInstance(instance, true).catch(() => undefined);
      throw error;
    }

    return instance;
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

    return {
      server,
      port: address.port,
      connected: once(server, 'connection') as Promise<[net.Socket]>
    };
  }

  private emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}
