import * as vscode from 'vscode';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activate } from '../src/extension';

// The e2e suite asserts pid continuity across watch reruns to prove warm
// extension-host reuse (a cold boot would produce a different pid).
const hostPidFile = new URL('../.e2e-host-pid-vscode-api-pass', import.meta.url);

describe('vscode API', () => {
  it('exposes the extension host API', () => {
    expect(typeof vscode.window.createOutputChannel).toBe('function');
    expect(typeof vscode.commands.executeCommand).toBe('function');
  });

  it('runs inside the extension host', async () => {
    const doc = await vscode.workspace.openTextDocument({ content: 'hello from the extension host' });
    expect(doc.getText()).toBe('hello from the extension host');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });

  it('forwards console output to vitest', () => {
    console.log('e2e: console forwarded from the extension host');
  });

  it('records which extension host process ran it', () => {
    writeFileSync(hostPidFile, String(process.pid));
  });
});

describe('sample extension', () => {
  it('can be imported and activated directly from source', () => {
    const subscriptions: vscode.Disposable[] = [];
    activate({ subscriptions } as unknown as vscode.ExtensionContext);
    expect(subscriptions).toHaveLength(1);
    subscriptions.forEach(disposable => disposable.dispose());
  });

  it('registers and executes a command', async () => {
    const subscriptions: vscode.Disposable[] = [];
    activate({ subscriptions } as unknown as vscode.ExtensionContext);

    await expect(vscode.commands.executeCommand('sample-extension.helloWorld')).resolves.toBeUndefined();

    subscriptions.forEach(disposable => disposable.dispose());
  });
});
