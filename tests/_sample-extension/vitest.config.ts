import { defineConfig } from 'vitest/config';
import vscode from 'vitest-plugin-vscode';

export default defineConfig({
  plugins: [
    vscode({
      version: 'stable',
      // No `--log` here: the runner defaults it to `info` so the extension
      // host log (its diagnostics source) gets written.
      launchArgs: ['--disable-gpu'],
    })
  ],
  test: {
    include: ['tests/**/*.test.ts']
  }
});
