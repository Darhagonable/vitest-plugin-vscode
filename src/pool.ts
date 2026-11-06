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
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;
  private file: string | undefined;
  private startRequest: WorkerRequest | undefined;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions,
    private readonly instances: Map<string, VSCodePoolWorker>
  ) { this.ipc = new LineIpc(new net.Socket()); } // placeholder: holds vitest's subscriptions until runSession rewires them

  on(event: string, callback: (arg: unknown) => void) {
    this.ipc?.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.ipc?.off(event, callback);
  }

  send(message: WorkerRequest) {
    switch (message.type) {
      case 'start': this.startRequest = message; // hold for replay: the file is only named by the run request that follows
        return this.ipc?.emit('message', { type: 'started', __vitest_worker_response__: true });
      case 'stop': // only after a normal run: the claimed instance is parked — detach so stop() leaves it warm
        if (this.ipc && this.file && this.options.reuseWorker !== false && this.poolOptions.project.config.watch) {
          this.ipc.emit('message', { type: 'stopped', __vitest_worker_response__: true });
          this.ipc.removeAllListeners(); this.ipc.on('error', () => {}); // withdraw vitest's listeners; keep a sink so run.crash emissions cannot throw
          return void (this.ipc = undefined);
        }
        break; // ineligible: forward the real stop, then stop() retires the instance
      case 'run': case 'collect':
        if (this.file) break; // a runner kept alive by `isolate: false` reuses its open session
        const host = this.instances.get(this.file = message.context.files[0].filepath) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances);
        this.instances.set(this.file, host); // claim: the entry stays until the next run takes it
        return void this.runSession(host, message).catch((error) => { if (this.file) this.instances.delete(this.file); this.ipc?.emit('error', error); });
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
  private async boot() {
    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    process.once('exit', () => { this.ipc?.destroy(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); if (this.profilePath) { try { rmSync(this.profilePath, { recursive: true, force: true }); } catch {} } }); // crash-path: let the instance exit, then remove its profile

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
        this.ipc.on('error', () => {}); // run.crash emissions must not throw on a bare, parked socket
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

  private async runSession(host: VSCodePoolWorker, request: WorkerRequest) {
    if (!host.server) await host.boot();
    if (this.ipc && host.ipc) // move vitest's subscriptions from the placeholder to the real socket
      for (const event of ['message', 'error', 'exit'] as const)
        for (const listener of this.ipc.listeners(event)) host.ipc.on(event, listener);
    const ipc = this.ipc = host.ipc ?? ((): LineIpc => { throw new Error('The VS Code extension-host bridge is not connected.'); })();
    ipc.send(this.startRequest); // the first reply to it is the "started" ack
    await Promise.race([once(ipc, 'message'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for the VS Code extension host to start.')), 30_000).unref())]);
    ipc.send(request);
  }
  canReuse() {
    return this.options.reuseWorker !== false;
  }
}
