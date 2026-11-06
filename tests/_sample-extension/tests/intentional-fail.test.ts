// This file genuinely fails on every run: it is the fixture through which
// the e2e suite (tests/vscode-worker.test.ts) verifies that assertion
// failures, thrown runtime errors, and it.fails semantics cross the
// extension-host bridge and are reported correctly by the outer Vitest.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The e2e suite asserts pid continuity across watch reruns to prove warm
// extension-host reuse (a cold boot would produce a different pid).
const hostPidFile = new URL('../.e2e-host-pid-intentional-fail', import.meta.url);

describe('intentional failure', () => {
  it('fails on purpose', () => {
    expect(1).toBe(2);
  });

  it('throws on purpose', () => {
    throw new Error('boom from the extension host');
  });

  it.fails('expected failure passes through', () => {
    expect(1).toBe(2);
  });

  it('records which extension host process ran it', () => {
    writeFileSync(hostPidFile, String(process.pid));
  });
});
