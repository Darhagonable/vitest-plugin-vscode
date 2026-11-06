import { EventEmitter, once } from 'node:events';
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

  private events = new EventEmitter();
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
  ) {}

  on(event: string, callback: (arg: unknown) => void) {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void) {
    this.events.off(event, callback);
  }

  send(message: WorkerRequest) {
    // Acknowledge for the extension host: the file is only named by the run request that follows.
    if (message.type === 'start') {
      this.startRequest = message;
      return this.events.emit('message', { type: 'started', __vitest_worker_response__: true });
    }
    // "stop" only follows a normal run: the claimed instance is parked — detach so stop() leaves it warm.
    if (message.type === 'stop' && this.ipc && this.file && this.options.reuseWorker !== false && this.poolOptions.project.config.watch) {
      this.ipc = undefined; // the parked instance keeps its bridge
      return this.events.emit('message', { type: 'stopped', __vitest_worker_response__: true });
    }
    if ((message.type === 'run' || message.type === 'collect') && !this.file) {
      this.file = message.context.files[0].filepath;
      const host = this.instances.get(this.file) ?? new VSCodePoolWorker(this.poolOptions, this.options, this.instances);
      this.instances.set(this.file, host); // claim: the entry stays until the next run takes it
      return void this.runSession(host, message);
    }
    if (!this.ipc) {
      this.emitError(new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
  }

  private async boot() {
    if (this.ipc)
      return;

    const config = this.poolOptions.project.config;
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);
    const sweep = () => { this.ipc?.destroy(); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500); if (this.profilePath) { try { rmSync(this.profilePath, { recursive: true, force: true }); } catch {} } };
    process.once('exit', sweep); // crash-path cleanup: let the instance exit, then remove its profile

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
      const server = net.createServer((socket) => {
        this.ipc = new LineIpc(socket);
        this.ipc.on('message', (message) => this.events.emit('message', message));
        this.ipc.on('error', (error) => this.emitError(error));
        this.ipc.on('close', () => {
          if (!this.stopping)
            this.events.emit('exit');
        });
      });

      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      this.server = server;

      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Could not allocate IPC port for VS Code Vitest worker.');
      }

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
        once(server, 'connection'),
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
          this.emitError(error);
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
    try {
      if (!host.ipc) await host.boot();
      host.events = this.events; // the socket's wiring now feeds this task
      this.ipc = host.ipc;
      this.ipc?.send(this.startRequest); // the first reply to it is the "started" ack
      await Promise.race([
        once(this.events, 'message'),
        once(this.events, 'exit').then(() => { throw new Error('The VS Code extension host exited.'); }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for the VS Code extension host to start.')), 30_000).unref())
      ]);
      this.ipc?.send(request);
    } catch (error) {
      if (this.file) this.instances.delete(this.file); // never leave a failed session's instance claimed
      this.emitError(error);
    }
  }

  canReuse() {
    return this.options.reuseWorker !== false;
  }

  private emitError(error: unknown) {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}
