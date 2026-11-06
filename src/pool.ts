import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
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
  private ipc: LineIpc | undefined = new LineIpc(new net.Socket()); // placeholder: holds vitest's subscriptions until _start pumps
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

  constructor(
    private readonly instances: Map<string, VSCodePoolWorker>,
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) {
      case 'start': return this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true }); // the placeholder cannot genuinely ack: the file is only named by the run request that follows
      case 'run': case 'collect': return void this._start(message.context.files[0].filepath, message).catch(() => this.instances.delete(message.context.files[0].filepath)); // never leave a failed session's claim behind
      case 'stop': if (this.ipc && this.options.reuseWorker !== false && this.poolOptions.project.config.watch) { // park: acknowledge so the bridge never sees the teardown; the claim stays warm
          this.ipc.emit('message', { type: 'stopped', __vitest_worker_response__: true });
          this.run = undefined; // parked: stop() no-ops; vitest withdraws its listeners from the still-attached bridge
          return;
        }
        break; // ineligible: the real stop forwards through the tail, then stop() retires
    }
    if (!this.ipc)
      throw new Error('VS Code extension-host worker is not connected.');

    this.ipc.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
  }

  private async launch() {
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    process.once('exit', () => {
      this.ipc?.destroy(); // actively close the bridge so the instance exits before the sweep
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000); // outlive its final writes
      try { rmSync(this.profilePath ?? '', { recursive: true, force: true }); } catch {} // graceful retire rm'd already; this is the crash path
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
          ...this.options.extensionTestsEnv,
          VITEST_RUNNER_IPC_HOST: '127.0.0.1',
          VITEST_RUNNER_IPC_PORT: String(address.port)
        },
        stdout: this.options.stdout,
        stderr: this.options.stderr,
        launchArgs: launchArgs,
        reporter: new SilentReporter()
      });

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

      this.run.catch((error) => {
        if (!this.stopping)
          this.ipc?.emit('error', error);
      });
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  async stop() {
    if (this.run === undefined) return; // parked: its bridge stays warm; residue retires via the exit sweep
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

  private async _start(file: string, request: WorkerRequest) {
    const host = this.instances.get(file) ?? new VSCodePoolWorker(this.instances, this.poolOptions, this.options); // get-or-insert: a dedicated host per file
    this.instances.set(file, host);
    if (host.server === undefined) { // cold: boot it and start its runtime; a warm host keeps its first session
      await host.launch();
      host.ipc?.send({ __vitest_worker_request__: true, type: 'start', poolId: 0, workerId: 0, options: { reportMemory: false }, context: { environment: this.poolOptions.environment, config: this.poolOptions.project.serializedConfig, pool: this.name }, traces: { enabled: false } }); // reconstructed start
      await once(host.ipc ?? new net.Socket(), 'message', { signal: AbortSignal.timeout(30_000) }); // the genuine "started" reply gates the run
    }
    host.ipc?.removeAllListeners(); // stale listeners from the previous task
    const from = this.ipc; // the placeholder carrying vitest's subscriptions
    for (const event of ['message', 'error', 'exit'] as const)
      for (const listener of from?.listeners(event) ?? []) host.ipc?.on(event, listener); // rewire: the subscriptions move onto the host bridge, so off() finds them
    this.ipc = host.ipc;
    this.ipc?.send(request);
  }
  canReuse() {
    return this.options.reuseWorker !== false;
  }
}
