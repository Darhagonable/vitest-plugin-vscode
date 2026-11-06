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
  private ipc: LineIpc | undefined = new LineIpc(new net.Socket()); // placeholder: vitest subscribes here; the facade's field never moves
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private host!: VSCodePoolWorker;

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
      case 'start': return this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true }); // toll: the placeholder cannot genuinely ack
      case 'stop': return this.ipc?.emit('message', { type: 'stopped', __vitest_worker_response__: true }); // toll: teardown waits; the parked runtime must never see the real one
      case 'run': case 'collect': return void this._start(message.context.files[0].filepath, message);
    }
    this.host.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // vitest's task-time start: the facade must never boot — hosts use launch()

  private async launch() { // main's start body minus its guard: a fresh host's placeholder ipc would trip it
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);

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

  private async _start(file: string, request: WorkerRequest) {
    const host = this.instances.get(file) ?? new VSCodePoolWorker(this.instances, this.poolOptions, this.options);
    if (this.poolOptions.project.config.watch && this.canReuse()) this.instances.set(file, host);
    this.host = host;
    if (!host.server) {
      await host.launch();
      host.ipc?.send({ type: 'start', __vitest_worker_request__: true, options: { reportMemory: false }, traces: { enabled: false }, context: { environment: { name: this.poolOptions.project.config.environment,
        options: this.poolOptions.project.config.environmentOptions }, config: this.poolOptions.project.serializedConfig, pool: this.name } }); // reconstructed start: the cold runtime bootstraps from it
      await (host.ipc ? once(host.ipc, 'message', { signal: AbortSignal.timeout(30_000) }) : undefined); // gate: run waits for the runtime's genuine reply
    }
    host.ipc?.removeAllListeners(); // retire the previous task's pump before re-subscribing
    for (const event of ['message', 'error', 'exit'])
      host.ipc?.on(event, (argument) => this.ipc?.emit(event, argument)); // the pump: host bridge into this task's placeholder
    host.ipc?.send(request);
  }

  async stop() {
    if (![...this.instances.values()].includes(this.host))
      void this.host?.stop(); // non-watch: retire the booted host; the body below is inert against this facade's placeholder
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
