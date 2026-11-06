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

  private host: VSCodePoolWorker | undefined;
  private held: WorkerRequest | undefined;
  private key = '';
  private forward: LineIpc | undefined;
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly instances: Map<string, VSCodePoolWorker>
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) {
      case 'stop': // parks only completed tasks — synthetic acks keep bridges alive
        this.host && this.poolOptions.project.config.watch && this.options.reuseWorker !== false ? this.instances.set(this.key, this.host) : void this.host?.stop().catch(() => undefined);
        return void this.ipc?.emit('message', { type: 'stopped', __vitest_worker_response__: true });
      case 'start':
        if (this.host) break; // already attached: forward the raw start below
        this.held = message; // cold only: the worker needs the real start (poolId/workerId)
        return void this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true });
      case 'run': case 'collect':
        this.key = message.context.files.map(file => file.filepath).join('\n');
        return void this.attach(message).catch(error => { this.ipc?.emit('error', error); void this.host?.stop().catch(() => undefined); });
    }
    if (this.host) return void this.host.ipc?.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    this.ipc = new LineIpc(new net.Socket()); this.ipc.on('error', () => {}); // placeholder for vitest's on()/off() (never replaced, so off() always hits it); sink for late pump emits
  }
  private async boot() {
    if (this.ipc)
      return;

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
        for (const event of ['message', 'error', 'exit']) this.ipc.on(event, (...args: unknown[]) => { if (event === 'exit') this.ipc = undefined; this.forward?.emit(event, ...args); }); // exit also marks dead hosts for reboot
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
  private async attach(message: WorkerRequest) {
    const host = this.instances.get(this.key) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances);
    this.instances.delete(this.key); // one bridge is never handed to two tasks
    if (!host.ipc) { // cold: replay the real start; its reply (or a 30s bound) orders the run
      await host.boot();
      await Promise.race([new Promise<void>(resolve => { host.ipc?.once('message', resolve); host.ipc?.send(this.held); }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('VS Code worker never finished starting.')), 30_000).unref())]);
    }
    (this.host = host).forward = this.ipc;
    this.host.ipc?.send(message);
  }
}
