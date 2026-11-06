import { once } from 'node:events';
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

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

  constructor(
    private readonly instances: Map<string, VSCodePoolWorker>,
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) { this.ipc = new LineIpc(new net.Socket()); } // placeholder: vitest's on()/off() land here, never replaced

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) {
      case 'start': // synthetic acks unblock the run request that names the files
        return void this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true });
      case 'run': case 'collect':
        return void this._start(message.context.files[0].filepath, message).catch((error) => this.ipc?.emit('error', error));
      case 'stop': // synthetic ack: parked bridges never see the teardown request
        return void this.ipc?.emit('message', { type: 'stopped', __vitest_worker_response__: true });
    }
    return void this.ipc?.emit('rpc', message); // rpc replies reach the adopted bridge via its forwarder
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {} // the placeholder is all vitest's task needs; hosts boot via _boot

  private async _boot() {
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    process.once('exit', () => { if (this.profilePath) rmSync(this.profilePath, { recursive: true, force: true }); });

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

  private async _start(file: string, request: WorkerRequest) {
    let host = this.instances.get(file);
    if (!host) {
      host = new VSCodePoolWorker(this.instances, this.poolOptions, this.options);
      this.instances.set(file, host); // claim before the boot: reruns wait on the same host
      await host._boot();
      const reply = host.ipc ? once(host.ipc, 'message', { signal: AbortSignal.timeout(30_000) }) : Promise.resolve();
      host.ipc?.send({ __vitest_worker_request__: true, type: 'start', options: { reportMemory: false }, traces: { enabled: false }, context: { environment: this.poolOptions.environment, config: this.poolOptions.project.serializedConfig } });
      await reply; // the bridge's first message answers the reconstructed start
    }
    host.ipc?.removeAllListeners();
    host.ipc?.on('exit', () => this.instances.delete(file)); // dead hosts vacate the map
    for (const event of ['message', 'error', 'exit']) host.ipc?.on(event, (...args: unknown[]) => { if (this.ipc?.listenerCount(event)) this.ipc?.emit(event, ...args); });
    this.ipc?.on('rpc', (message: unknown) => host.ipc?.send(message));
    host.ipc?.send(request);
  }
}
