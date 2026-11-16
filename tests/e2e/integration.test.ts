/*
 * E2E suite for the VS Code extension-host runner.
 *
 * Boots a single nested Vitest instance in watch mode on
 * tests/_sample-extension — the same plugin setup a consumer has — and
 * asserts on the results it reports. startVitest resolves once the
 * initial run finished; the small deferred reporter below is only needed
 * to await the watch-mode rerun. There are no other side channels.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startVitest, type Reporter, type Vitest } from 'vitest/node';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';

const sampleRoot = join(process.cwd(), 'tests/_sample-extension');

// The only watch side channel: resolves when the current run ends.
let resolveRunEnd: (() => void) | undefined;
const reporter: Reporter = { onTestRunEnd: () => resolveRunEnd?.() };
const awaitNextRun = () => new Promise<void>((resolve) => (resolveRunEnd = resolve));

let ctx: Vitest | undefined;

const findTest = (moduleFragment: string, testFragment: string) =>
  ctx?.state.getTestModules().find((m) => m.moduleId.includes(moduleFragment))
    ?.children.allTests().find((t) => t.name.includes(testFragment));

beforeAll(async () => {
  // Reset possible previous runs, like Vitest's own test harness does; the
  // nested run reports its fixture failures through process.exitCode.
  process.exitCode = 0;
  ctx = await startVitest([], { root: sampleRoot, watch: true, reporters: [reporter] });
}, 120_000);

afterAll(async () => {
  await ctx?.close();
  process.exitCode = 0;
});

describe('vscode extension-host pool', () => {
  it('keeps the VS Code download inside the sample extension', () => {
    expect(existsSync(join(sampleRoot, '.vscode-test'))).toBe(true);
    expect(existsSync(join(process.cwd(), '.vscode-test'))).toBe(false);
  });

  it('runs tests inside the extension host', () => {
    expect(findTest('vscode-api-pass', 'runs inside the extension host')?.ok()).toBe(true);
  });

  it('exposes the vscode APIs to tests', () => {
    expect(findTest('vscode-api-pass', 'exposes the extension host API')?.ok()).toBe(true);
  });

  it('activates the extension with a real context', () => {
    expect(findTest('vscode-api-pass', 'is activated by VS Code')?.ok()).toBe(true);
  });

  it('registers and executes commands', () => {
    expect(findTest('vscode-api-pass', 'registers and executes its command')?.ok()).toBe(true);
  });

  it('reports failing sample tests as failed', () => {
    const failing = findTest('intentional-fail', 'fails on purpose');
    expect(failing?.ok()).toBe(false);
    expect(failing?.result().errors?.[0]?.message).toContain('expected 1 to be 2');
  });

  it('reports thrown errors as failed', () => {
    const thrown = findTest('intentional-fail', 'throws on purpose');
    expect(thrown?.ok()).toBe(false);
    expect(thrown?.result().errors?.[0]?.message).toBe('boom from the extension host');
  });

  it('reports expectedly failing tests as passed', () => {
    expect(findTest('intentional-fail', 'expected failure passes through')?.ok()).toBe(true);
  });

  it('forwards console output from the extension host', () => {
    const logs = findTest('vscode-api-pass', 'forwards console output')?.logs().map((log) => log.content).join('');
    expect(logs).toContain('e2e: console forwarded from the extension host');
  });

  it('supports watch mode test reruns', { timeout: 120_000 }, async () => {
    const source = await readFile(join(sampleRoot, 'src/extension.ts'), 'utf8');

    onTestFinished(async () => {
      await writeFile(join(sampleRoot, 'src/extension.ts'), source);
    });

    const rerunEnded = awaitNextRun();
    // Content change, not just mtime: the watcher reliably schedules a rerun.
    await writeFile(join(sampleRoot, 'src/extension.ts'), `${source}\n// e2e: dependency rerun marker\n`);
    await rerunEnded;

    expect(findTest('vscode-api-pass', 'registers and executes its command')?.ok()).toBe(true);
  });
});
