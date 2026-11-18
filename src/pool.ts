import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
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
import { Ipc } from './utils/ipc';
import type { PoolOptions, PoolWorker, WorkerRequest } from 'vitest/node';
import type { VSCodeOptions } from './plugin';

const require = createRequire(import.meta.url);

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private server: net.Server | undefined;
  private ipc: Ipc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

  constructor(
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
    if (!this.ipc)
      throw new Error('VS Code extension-host worker is not connected.');

    this.ipc.send(message);
  }

  deserialize(data: unknown) {
    return data;
  }

  async start() {
    if (this.ipc)
      return;

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

    // On displayless Linux, VS Code needs the headless backend and
    // disabled GPU to run cleanly.
    if (process.platform === 'linux' && !process.env.DISPLAY)
      launchArgs.push('--ozone-platform=headless', '--disable-gpu');

    if (this.options.launchArgs)
      launchArgs.push(...this.options.launchArgs);

    try {
      this.server = net.createServer((socket) => {
        this.ipc = new Ipc(socket);
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
          // the extension host sets this; VS Code must boot as Electron, not Node
          ELECTRON_RUN_AS_NODE: undefined,
          VITEST_RUNNER_IPC_HOST: '127.0.0.1',
          VITEST_RUNNER_IPC_PORT: String(address.port)
        },
        stdout: this.options.stdout,
        stderr: this.options.stderr,
        launchArgs: launchArgs,
        reporter: new SilentReporter()
      });

      const connected = once(this.server, 'connection');
      const timer = setTimeout(config.inspector.waitForDebugger ? 300_000 : 30_000, 'timed out', { ref: false });

      const bridge = await Promise.race([connected, this.run, timer]);

      if (typeof bridge === 'number' /*run exit code */)
        throw new Error('VS Code exited before the extension-host Vitest bridge connected.');

      if (bridge === 'timed out')
        throw new Error('Timed out waiting for the VS Code extension-host Vitest bridge to connect.');

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
}
