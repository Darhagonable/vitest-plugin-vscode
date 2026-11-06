// The extension under development is activated for real by VS Code. This
// awaits that activation: healthy extensions resolve, broken ones rethrow
// the original activation error (with its stack) as a normal test failure.
import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';

describe('real extension activation', () => {
  it('activates the extension under development', async () => {
    const extension = vscode.extensions.getExtension('vitest-plugin-vscode.sample-extension');

    expect(extension, 'dev extension should be loaded').toBeTruthy();
    expect(extension?.packageJSON.main).toBe('./src/extension-main.mjs');

    await extension!.activate();
  });
});
