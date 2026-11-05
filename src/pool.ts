import { EventEmitter } from 'node:events';
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

export class VSCodePoolWorker implements PoolWorker {
  readonly name = 'vscodePool';

  private readonly events = new EventEmitter();
  private server: net.Server | undefined;
  private ipc: LineIpc | undefined;
  private run: Promise<number> | undefined;
  private profilePath: string | undefined;
  private stopping = false;

  constructor(
    private readonly poolOptions: PoolOptions,
    private readonly options: VSCodeOptions
  ) {}

  on(event: string, callback: (arg: unknown) => void): void {
    this.events.on(event, callback);
  }

  off(event: string, callback: (arg: unknown) => void): void {
    this.events.off(event, callback);
  }

  send(message: unknown): void {
    if (!this.ipc) {
      this.emitError(new Error('VS Code extension-host worker is not connected.'));
      return;
    }

    this.ipc.send(message);
  }

  deserialize(data: unknown): unknown {
    return data;
  }

  async start(): Promise<void> {
    if (this.ipc) {
      return;
    }

    const { server, port, connected } = await this.createServer();
    this.server = server;

    // Anchor the download cache at the project root so nothing leaks outside
    // the package in monorepos. Per-worker profiles live in the OS temp dir:
    // short (unix socket path limits) and cleaned up on stop.
    const root = this.poolOptions.project.config.root;
    const cachePath = path.resolve(root, this.options.cachePath ?? '.vscode-test');
    this.profilePath = path.join(os.tmpdir(), `vsct-${randomUUID().slice(0, 8)}`);

    // Per-worker user-data and extensions dirs go in first: concurrent VS Code
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

    const debugArg = this.createDebugLaunchArg();
    if (debugArg) {
      launchArgs.push(debugArg);
    }

    if (this.options.launchArgs) {
      launchArgs.push(...this.options.launchArgs);
    }

    // VS Code's Vitest extension runs test processes under Electron-as-Node.
    // The spawned VS Code must start as Electron, not inherit that mode.
    // runTests() merges process.env, so sanitize the environment directly.
    delete process.env.ELECTRON_RUN_AS_NODE;

    this.run = runTests({
      vscodeExecutablePath: this.options.vscodeExecutablePath,
      version: process.env.VSCODE_VERSION ?? this.options.version,
      cachePath,
      extensionDevelopmentPath: this.options.extensionDevelopmentPath ?? root,
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
        if (!bridgeConnected) {
          throw new Error('VS Code exited before the extension-host Vitest bridge connected.');
        }
      },
      error => {
        if (!bridgeConnected) {
          throw error;
        }
      }
    );

    try {
      await withTimeout(
        Promise.race([
          connectedBeforeExit,
          exitedBeforeConnect
        ]),
        this.poolOptions.project.config.inspector.waitForDebugger ? 300_000 : 30_000,
        'Timed out waiting for the VS Code extension-host Vitest bridge to connect.'
      );
    } catch (error) {
      await this.cleanupAfterFailedStart();
      throw error;
    }

    this.run.catch(error => {
      if (!this.stopping) {
        this.emitError(error);
      }
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ipc?.close();
    this.server?.close();

    try {
      if (this.run) {
        // No timeout: vitest's own teardownTimeout bounds the whole pool.
        await this.run;
      }
    } catch (error) {
      if (!(error instanceof TestRunFailedError)) {
        throw error;
      }
    } finally {
      this.ipc = undefined;
      this.server = undefined;
      this.run = undefined;
      this.stopping = false;

      if (this.profilePath) {
        await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
        this.profilePath = undefined;
      }
    }
  }

  canReuse(): boolean {
    return this.options.reuseWorker !== false;
  }

  private createDebugLaunchArg(): string | undefined {
    const { enabled, port = 9229, waitForDebugger } = this.poolOptions.project.config.inspector;
    if (!enabled) {
      return undefined;
    }

    return waitForDebugger
      ? `--inspect-brk-extensions=${port}`
      : `--inspect-extensions=${port}`;
  }

  private async createServer() {
    const server = net.createServer();

    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', error => reject(new Error('Could not start the local TCP server for the VS Code Vitest worker.', { cause: error })));
      server.listen(0, '127.0.0.1');
    });

    const address = server.address();

    if (!address || typeof address === 'string') {
      throw new Error('Could not allocate TCP port for VS Code Vitest worker.');
    }

    let resolveConnected: () => void = () => {};
    let rejectConnected: (reason?: any) => void = () => {};
    const connected = new Promise<void>((resolve, reject) => {
      resolveConnected = resolve;
      rejectConnected = reject;
    });

    server.on('error', rejectConnected);

    server.on('connection', socket => {
      let bridgeReady = false;
      this.ipc = new LineIpc(socket);
      this.ipc.on('message', message => {
        if (isBridgeReadyMessage(message)) {
          bridgeReady = true;
          resolveConnected();
          return;
        }

        this.events.emit('message', message);
      });
      this.ipc.on('error', error => {
        if (bridgeReady) {
          this.emitError(error);
        } else {
          rejectConnected(error);
        }
      });
      this.ipc.on('close', () => {
        if (!bridgeReady) {
          rejectConnected(new Error('VS Code extension-host Vitest bridge disconnected before it became ready.'));
          return;
        }

        if (!this.stopping) {
          this.events.emit('exit');
        }
      });
    });

    return {
      server,
      port: address.port,
      connected
    };
  }

  private async cleanupAfterFailedStart() {
    this.stopping = true;
    this.ipc?.destroy();
    this.server?.close();

    if (this.profilePath) {
      await rm(this.profilePath, { recursive: true, force: true }).catch(() => undefined);
      this.profilePath = undefined;
    }

    this.ipc = undefined;
    this.server = undefined;
    this.run = undefined;
    this.stopping = false;
  }

  private emitError(error: unknown): void {
    if (this.events.listenerCount('error') > 0) {
      this.events.emit('error', error);
    }
  }
}

function isBridgeReadyMessage(message: unknown) {
  return typeof message === 'object'
    && message !== null
    && (message as { __vscode_vitest_bridge_ready__?: boolean }).__vscode_vitest_bridge_ready__ === true;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<void> ((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
    timeout.unref();
  });

  return Promise.race([
    promise,
    timeoutPromise
  ]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}
