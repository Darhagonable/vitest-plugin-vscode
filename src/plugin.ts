import * as path from 'node:path';
import type { Plugin } from 'vitest/config';
import { downloadAndUnzipVSCode, type DownloadOptions, type TestOptions } from '@vscode/test-electron';
import type { DownloadPlatform, DownloadVersion } from '@vscode/test-electron/out/download.js';
import { VSCodePoolWorker } from './pool';

/** Matching {@link TestOptions} and {@link DownloadOptions}. */
export interface VSCodeOptions {
  /**
   * The VS Code version to download. Valid versions are:
   * - `'stable'`
   * - `'insiders'`
   * - `'1.32.0'`, `'1.31.1'`, etc
   *
   * Defaults to `stable`, which is latest stable version.
   *
   * *If a local copy exists at `.vscode-test/vscode-<VERSION>`, skip download.*
   */
  version?: DownloadVersion;
  /**
   * The VS Code platform to download. If not specified, it defaults to the
   * current platform.
   *
   * Possible values are:
   * 	- `win32-x64-archive`
   * 	- `win32-arm64-archive`
   * 	- `darwin`
   * 	- `darwin-arm64`
   * 	- `linux-x64`
   * 	- `linux-arm64`
   * 	- `linux-armhf`
   */
  platform?: DownloadPlatform;
  /**
   * Path where the downloaded VS Code instance is stored.
   * Defaults to `.vscode-test` within the project root.
   */
  cachePath?: string;
  /**
   * The VS Code executable path used for testing.
   *
   * If not passed, will use `options.version` to download a copy of VS Code
   * for testing. If `version` is not specified either, will download and use
   * latest stable release.
   */
  vscodeExecutablePath?: string;
  /**
   * Whether VS Code should be launched using default settings and extensions
   * installed on this machine. If `false`, then separate directories will
   * be used inside the `.vscode-test` folder within the project.
   *
   * Defaults to `false`.
   */
  reuseMachineInstall?: boolean;
  /**
   * Absolute path to the extension root. Passed to `--extensionDevelopmentPath`.
   * Must include a `package.json` Extension Manifest.
   *
   * Defaults to the vitest project root.
   */
  extensionDevelopmentPath?: string | string[];
  /**
   * A list of launch arguments passed to VS Code executable, in addition to
   * `--extensionDevelopmentPath` and `--extensionTestsPath` which are provided
   * by `extensionDevelopmentPath` and the runner's bridge respectively.
   *
   * If the first argument is a path to a file/folder/workspace, the launched
   * VS Code instance will open it.
   *
   * See `code --help` for possible arguments.
   */
  launchArgs?: string[];
  /**
   * Number of milliseconds after which to time out if no data is received
   * from the remote when downloading VS Code. Note that this is an 'idle'
   * timeout and does not enforce the total time VS Code may take to download.
   */
  timeout?: number;
  /** Keep VS Code instances warm between test runs (watch mode). */
  reuseWorker?: boolean;
}

export function vscodePlugin(options: VSCodeOptions = {}): Plugin {
  const instances = new Map<string, VSCodePoolWorker>();
  return {
    name: 'vitest-plugin-vscode',
    config: (config) => {
      if (config.test?.pool !== undefined)
        throw new Error('[vitest-plugin-vscode] test.pool is managed by vscodePlugin().');

      config.test ??= {};
      config.test.pool = {
        name: 'vscodePool',
        createPoolWorker: (poolOptions) => new VSCodePoolWorker(poolOptions, options, instances)
      };
    },
    configResolved: async (resolved) => {
      options.vscodeExecutablePath ??= await downloadAndUnzipVSCode({
        cachePath: path.resolve(resolved.root, options.cachePath ?? '.vscode-test'),
        version: process.env.VSCODE_VERSION ?? options.version,
        platform: options.platform,
        timeout: options.timeout
      });
    },
    resolveId: (id) => {
      // inline shim exposing the vscode API to test files
      if (id === 'vscode')
        return `data:text/javascript,${encodeURIComponent('export * from "vscode";')}`;
    },
    closeServer: async () => {
      await Promise.all(instances.values().map((host) => host.stop()));
    }
  };
}
