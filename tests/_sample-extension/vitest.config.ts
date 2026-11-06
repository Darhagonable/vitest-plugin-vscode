import { defineConfig } from 'vitest/config';
import vscode from 'vitest-plugin-vscode';

export default defineConfig({
  plugins: [
    vscode({
      version: 'stable',
      launchArgs: ['--log', 'off', '--disable-gpu'],
      reuseWorker: true,
    })
  ],
  test: {
    include: ['tests/**/*.test.ts']
  }
});
