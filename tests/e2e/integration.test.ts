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
const sampleTestFile = join(sampleRoot, 'tests/vscode-api-pass.test.ts');

// Written by the sample tests from inside the extension host: the pid of the
// process that ran them. Stable pid = warm reuse; distinct pids = per-file
// extension hosts.
const pidFileA = join(sampleRoot, '.e2e-host-pid-vscode-api-pass');
const pidFileB = join(sampleRoot, '.e2e-host-pid-intentional-fail');

// Watch-mode runs may interleave (e.g. a watcher restore-rerun); poll the
// reported state until a condition holds instead of counting run events.
const waitUntil = async (condition: () => boolean, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the watch-mode rerun to be reported.');
    }

    await new Promise(resolve => setTimeout(resolve, 200));
  }
};

// The only watch side channel: resolves when the current run ends.
let resolveRunEnd: (() => void) | undefined;
const reporter: Reporter = { onTestRunEnd: () => resolveRunEnd?.() };
const awaitNextRun = () => new Promise<void>(resolve => (resolveRunEnd = resolve));

let ctx: Vitest | undefined;

const findTest = (moduleFragment: string, testFragment: string) =>
  ctx?.state.getTestModules().find(m => m.moduleId.includes(moduleFragment))
    ?.children.allTests().find(t => t.name.includes(testFragment));

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

  it('activates the extension directly from source', () => {
    expect(findTest('vscode-api-pass', 'activated directly from source')?.ok()).toBe(true);
  });

  it('registers and executes commands', () => {
    expect(findTest('vscode-api-pass', 'registers and executes a command')?.ok()).toBe(true);
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
    const logs = findTest('vscode-api-pass', 'forwards console output')?.logs().map(log => log.content).join('');
    expect(logs).toContain('e2e: console forwarded from the extension host');
  });

  it('reruns tests inside the same extension host on file change', { timeout: 120_000 }, async () => {
    const pidBefore = await readFile(pidFileA, 'utf8');

    const source = await readFile(sampleTestFile, 'utf8');
    onTestFinished(async () => {
      await writeFile(sampleTestFile, source);
    });

    const rerunEnded = awaitNextRun();
    // Content change, not just mtime: the watcher reliably schedules a rerun.
    await writeFile(sampleTestFile, `${source}\nit('e2e rerun marker', () => { expect(1).toBe(1); });\n`);
    await rerunEnded;

    expect(findTest('vscode-api-pass', 'e2e rerun marker')?.ok()).toBe(true);
    // Same extension host process: the warm pool adopted this file's own
    // instance instead of cold-booting a replacement.
    expect(await readFile(pidFileA, 'utf8')).toBe(pidBefore);
  });

  it('keeps each test file in its own extension host across reruns', { timeout: 120_000 }, async () => {
    const sourceA = await readFile(sampleTestFile, 'utf8');
    const sampleFixtureFile = join(sampleRoot, 'tests/intentional-fail.test.ts');
    const sourceB = await readFile(sampleFixtureFile, 'utf8');

    onTestFinished(async () => {
      await Promise.all([
        writeFile(sampleTestFile, sourceA),
        writeFile(sampleFixtureFile, sourceB)
      ]);
    });

    const pidABefore = await readFile(pidFileA, 'utf8');
    const pidBBefore = await readFile(pidFileB, 'utf8');
    // Separate VS Code instances per file — no cross-file state leakage.
    expect(pidABefore).not.toBe(pidBBefore);

    await Promise.all([
      writeFile(sampleTestFile, `${sourceA}\nit('e2e cross-file marker A', () => { expect(1).toBe(1); });\n`),
      writeFile(sampleFixtureFile, `${sourceB}\nit('e2e cross-file marker B', () => { expect(1).toBe(1); });\n`)
    ]);

    // Watcher restore-reruns from earlier tests may interleave; wait until a
    // run actually reports both markers rather than betting on run ordering.
    await waitUntil(() =>
      findTest('vscode-api-pass', 'e2e cross-file marker A')?.ok() === true
      && findTest('intentional-fail', 'e2e cross-file marker B')?.ok() === true
    );

    // Each file returned to its own instance: stable pids on both sides.
    expect(await readFile(pidFileA, 'utf8')).toBe(pidABefore);
    expect(await readFile(pidFileB, 'utf8')).toBe(pidBBefore);
  });
});
