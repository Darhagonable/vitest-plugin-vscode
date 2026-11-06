import * as path from 'node:path';
import type { Plugin } from 'vitest/config';
import { downloadAndUnzipVSCode, type TestOptions } from '@vscode/test-electron';
import { VSCodePoolWorker } from './pool';

export interface VSCodeOptions extends Partial<Omit<TestOptions, 'extensionTestsPath'>> {
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
        createPoolWorker: (poolOptions) => new VSCodePoolWorker(instances, poolOptions, options)
      };
    },
    configResolved: async (resolved) => {
      options.vscodeExecutablePath ??= await downloadAndUnzipVSCode({
        ...options,
        cachePath: path.resolve(resolved.root, options.cachePath ?? '.vscode-test'),
        version: process.env.VSCODE_VERSION ?? options.version,
      });
    },
    resolveId: (id) => {
      // inline shim exposing the vscode API to test files
      if (id === 'vscode')
        return `data:text/javascript,${encodeURIComponent('export * from "vscode";')}`;
    },
    closeServer: async () => { await Promise.all([...instances.values()].map((host) => host.stop())); } // graceful retire: close, await exit, rm profile
  };
}
