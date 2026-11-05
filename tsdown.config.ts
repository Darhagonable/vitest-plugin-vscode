import { defineConfig } from 'tsdown';

export default defineConfig({
  // the vscode worker is loaded by @vscode/test-electron by path,
  // so bundlers can't discover it — it must be listed explicitly
  entry: ['src/index.ts', 'src/vscode-worker.ts'],
  format: ['esm', 'cjs'],
  sourcemap: true,
  hash: false,
});
