import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
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

// Profiles of hosts that never reached dispose(): swept on process exit so
// even a suite that fails before closeServer leaves nothing in the temp dir.
// (The VS Code processes themselves die with the bridge sockets.)
const liveProfiles = new Set<string>();
let exitHooked = false;

function sweepProfilesOnExit() {
  if (exitHooked)
    return;

  exitHooked = true;
  process.on('exit', () => {
    for (const profile of liveProfiles)
      rmSync(profile, { recursive: true, force: true });
  });
}

/**
 * One live VS Code extension host and its IPC bridge. A host is owned by a
 * single {@link VSCodePoolWorker} while its task runs; between watch reruns it
 * sits warm in a {@link WarmHosts} pool, so the same files always return to
 * the same process and a different file never runs in it.
 */
class ExtensionHost {
  private server?: net.Server;
  private ipc?: LineIpc;
  private run?: Promise<number>;
  private profilePath: string | undefined;
  private stopping = false;
  /** The bridge socket closed: this host is gone and can never run again. */
  dead = false;
  /** The owning worker's event stream; undefined while the host sits warm. */
  sink?: EventEmitter;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {
    sweepProfilesOnExit();
  }

  async start() {
    if (this.ipc)
      return;

    try {
      await this.connect();
    } catch (error) {
      await this.dispose(true);
      throw error;
    }

    this.run?.catch((error) => {
      if (!this.stopping)
        this.emit('error', error);
    });
  }

  send(message: unknown) {
    if (!this.ipc) {
      this.emit('error', new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
  }

  private async connect() {
    const { server, port, connected } = await this.createServer();
    this.server = server;

    // Anchor the download cache at the project root so nothing leaks outside
    // the package in monorepos. Per-host profiles live in the OS temp dir:
    // short (unix socket path limits) and cleaned up on stop.
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    liveProfiles.add(this.profilePath);

    // Per-host user-data and extensions dirs go in first: concurrent VS Code
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
        liveProfiles.delete(this.profilePath);
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
      this.ipc.on('message', (message) => this.sink?.emit('message', message));
      this.ipc.on('error', (error) => this.emit('error', error));
      this.ipc.on('close', () => {
        this.dead = true;

        if (this.stopping)
          return;

        if (this.sink)
          this.sink.emit('exit');
        else
          // The host died while warm: nobody owns it, so clean it up here.
          this.dispose(false).catch(() => undefined);
      });
    });

    return {
      server,
      port: address.port,
      connected: once(server, 'connection')
    };
  }

  private emit(event: 'error', error: unknown) {
    const { sink } = this;
    if (sink && sink.listenerCount('error') > 0)
      sink.emit('error', error);
  }
}

/** Warm extension hosts parked between watch reruns, keyed by test files. */
export class WarmHosts {
  private readonly hosts = new Map<string, ExtensionHost>();

  /** Take the host parked for these files, if it is alive and unowned. */
  take(key: string) {
    const host = this.hosts.get(key);
    this.hosts.delete(key);
    return host && !host.dead ? host : undefined;
  }

  /** Park a host for the next run of the same files; dead ones are disposed. */
  async park(key: string, host: ExtensionHost) {
    const stale = this.hosts.get(key);
    this.hosts.delete(key);

    if (!host.dead)
      this.hosts.set(key, host);

    await Promise.all([stale, host.dead ? host : undefined].map(host => host?.dispose(false)));
  }

  /** Tear down every parked host: closes the bridges, awaits VS Code exits. */
  async close() {
    const hosts = [...this.hosts.values()];
    this.hosts.clear();
    await Promise.all(hosts.map(host => host.dispose(false)));
  }
}

/**
 * The pool worker vitest talks to. Vitest (with `isolate: true`) creates one
 * per task and only reveals the task's files with the run request — after the
 * start handshake. So the worker defers that choice: it answers the handshake
 * itself, then adopts a warm host for exactly those files (booting a fresh
 * one on a miss) and replays the held messages to it. The stop handshake is
 * answered locally too, which is what keeps the host alive for the next rerun
 * of the same file.
 */
export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private readonly buffered: WorkerRequest[] = [];
  // The start handshake arrives before the run request names the files, so it
  // is held and replayed to the adopted host once they are known.
  private startMessage: WorkerRequest | undefined;
  private host: ExtensionHost | undefined;
  private key: string | undefined;
  private stopped = false;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly warmHosts: WarmHosts
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.events.off(event, callback);
  }

  send(message: WorkerRequest) {
    if (this.host) {
      // Recycling the worker must not tear a warm extension host down, so the
      // proxy answers vitest's stop handshake on the host's behalf.
      if (message.__vitest_worker_request__ && message.type === 'stop') {
        this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
        return;
      }

      this.host.send(message);
      return;
    }

    // Vitest refuses to send the run request — the only message naming the
    // task's files — before the handshake completes, so the proxy answers the
    // handshake itself and holds the message for replay.
    if (message.__vitest_worker_request__ && message.type === 'start') {
      this.startMessage = message;
      this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
      return;
    }

    this.buffered.push(message);

    if (message.__vitest_worker_request__ && (message.type === 'run' || message.type === 'collect'))
      this.adopt(message.context.files);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    // Nothing to boot yet: which extension host to use is only known once the
    // run request arrives. See send().
  }

  async stop() {
    this.stopped = true;
    const host = this.host;
    this.host = undefined;

    if (!host)
      return; // Still booting: the attach continuation disposes it.

    host.sink = undefined;

    // Watch reruns reuse their file's warm host; every other run (and any
    // opt-out) keeps the cold behavior of tearing the host down per task.
    if (this.poolOptions.project.config.watch && this.options.reuseWorker !== false)
      await this.warmHosts.park(this.key!, host);
    else
      await host.dispose(false);
  }

  private adopt(files: { filepath: string }[]) {
    this.key = files.map(file => file.filepath).join('\n');

    const host = this.warmHosts.take(this.key) ?? new ExtensionHost(this.poolOptions, this.options);
    host.sink = this.events;

    // start() resolves immediately for a warm host (its bridge is already up)
    // and boots VS Code for a fresh one.
    host.start().then(
      () => this.attach(host),
      (error) => {
        host.sink = undefined;

        if (this.events.listenerCount('error') > 0)
          this.events.emit('error', error);
      }
    );
  }

  private async attach(host: ExtensionHost) {
    if (this.stopped)
      return this.retire(host);

    if (this.startMessage) {
      // The extension host initializes asynchronously while handling 'start'
      // and loses messages that overtake that, so the replay must await its
      // real 'started' reply — the ordering vitest's own pools get by
      // resolving the handshake before requesting the run.
      const replied = new Promise<void>((resolve) => {
        const finish = () => {
          this.events.off('message', onMessage);
          this.events.off('exit', finish);
          resolve();
        };
        const onMessage = (response: { type?: string }) => {
          if (response.type === 'started')
            finish();
        };
        this.events.on('message', onMessage);
        this.events.on('exit', finish);
      });

      host.send(this.startMessage);
      this.startMessage = undefined;
      await replied;

      if (this.stopped)
        return this.retire(host);
    }

    this.host = host;
    this.buffered.splice(0).forEach(message => this.send(message));
  }

  private retire(host: ExtensionHost) {
    host.sink = undefined;
    return host.dispose(false);
  }
}
