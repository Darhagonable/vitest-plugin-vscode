import { once } from 'node:events';
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

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private host!: VSCodePoolWorker; // set by bind(); 'run'/'stop' never precede it
  private forward: LineIpc | undefined; // the task this host pumps bridge events into
  private held: WorkerRequest | undefined; // cold-only 'start' hold: the runtime rejects a 'run' without its setup

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly instances: Map<string, VSCodePoolWorker> = new Map()
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) { default: this.host?.ipc?.send(message);
      case 'start': this.held = message; this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true }); return;
      case 'stop': this.ipc?.emit('message', { type: 'stopped', __vitest_worker_response__: true });
        if (this.canReuse() && this.poolOptions.project.config.watch) {
          this.host.forward = undefined; // park: the bridge routes nowhere until adopted
        } else void this.host.stop(); return;
      case 'run': case 'collect': this.bind(message).catch((error) => { this.ipc?.emit('error', error); void this.host.stop(); });
    }
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() { this.ipc = new LineIpc(new net.Socket()); this.ipc.on('error', () => {}); } // placeholder: vitest subscribes here pre-run
  private async bind(runRequest: Extract<WorkerRequest, { type: 'run' | 'collect' }>) {
    const key = `${this.poolOptions.project.name}|${runRequest.context.files.map((file) => file.filepath)}`;
    this.instances.set(key, this.host = this.instances.get(key) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances));
    this.host.forward = this.ipc; const cold = !this.host.ipc; if (cold) {
      await this.host.boot(); this.host.ipc?.send(this.held);
      await Promise.race([ // gate on the runtime's genuine 'started': it handles 'start' asynchronously
        new Promise<void>((resolve) => this.ipc?.on('message', (message: { type?: string }) => { if (message.type === 'started') resolve(); })), new Promise((_, reject) =>
        setTimeout(reject, 60_000, new Error('Timed out waiting for the extension host to accept a run.')).unref())]);
    }
    this.held = undefined; this.host.ipc?.send(runRequest);
  }

  private async boot() { // main's start() body: hosts boot here
    if (this.ipc)
      return;

    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    process.once('exit', () => { // crash sweep: wait out the host, then rm
      if (!this.profilePath) return; this.ipc?.destroy(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
      require('node:fs').rmSync(this.profilePath, { recursive: true, force: true });
    });

    // User launchArgs append last so they win by ordering.
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

    // The spawned VS Code must start as Electron, not inherit the
    // Vitest extension's Electron-as-Node mode.
    delete process.env.ELECTRON_RUN_AS_NODE;

    try {
      this.server = net.createServer((socket) => {
        this.ipc = new LineIpc(socket);
        for (const event of ['message', 'error', 'exit']) this.ipc.on(event, (argument) => this.forward?.emit(event, argument)); // the pump
        this.ipc.on('exit', () => { // death eviction: the task learns via its pumped 'exit'
          for (const [key, host] of this.instances) if (host === this) this.instances.delete(key); if (!this.stopping) void this.cleanup();
        });
      });

      await once(this.server.listen(0, '127.0.0.1'), 'listening');
      const address = this.server.address();

      if (!address || typeof address === 'string')
        throw new Error('Could not allocate IPC port for VS Code Vitest worker.');

      this.run = runTests({
        vscodeExecutablePath: this.options.vscodeExecutablePath,
        version: process.env.VSCODE_VERSION ?? this.options.version,
        cachePath: this.options.cachePath,
        extensionDevelopmentPath: this.options.extensionDevelopmentPath ?? config.root,
        extensionTestsPath: require.resolve('./vscode-worker.mjs'),
        reuseMachineInstall: this.options.reuseMachineInstall,
        extensionTestsEnv: {
          VITEST_RUNNER_IPC_HOST: '127.0.0.1',
          VITEST_RUNNER_IPC_PORT: String(address.port)
        },
        launchArgs: launchArgs,
        reporter: new SilentReporter()
      });
      this.run.catch(() => {}); // timed-out boots / late host failures must not reject unobserved

      await Promise.race([
        once(this.server, 'connection'),
        this.run.then(() => {
          throw new Error('VS Code exited before the extension-host Vitest bridge connected.');
        }),
        new Promise((_, reject) => {
          setTimeout(() => {
            reject(new Error('Timed out waiting for the VS Code extension-host Vitest bridge to connect.'));
          }, config.inspector.waitForDebugger ? 300_000 : 30_000).unref();
        })
      ]);
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    this.stopping = true;
    try {
      this.ipc?.close();
      await this.run?.catch((error) => {
        if (!(error instanceof TestRunFailedError))
          throw error;
      });
    } finally {
      await this.cleanup();
    }
  }

  private async cleanup() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();
    this.ipc = undefined;
    this.server = undefined;
    this.run = undefined;
    if (this.profilePath) {
      await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
      this.profilePath = undefined;
    }
    this.stopping = false;
  }

  canReuse() {
    return this.options.reuseWorker !== false;
  }
}
