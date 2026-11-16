import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { commandId } from '../src/extension';

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
});

describe('sample extension', () => {
  it('is activated by VS Code', async () => {
    const extension = vscode.extensions.getExtension('vitest-plugin-vscode.sample-extension');

    if (!extension)
      throw new Error('sample extension not found');

    await extension.activate();
    expect(extension.isActive).toBe(true);
  });

  it('registers and executes its command', async () => {
    await expect(vscode.commands.executeCommand(commandId)).resolves.toBeUndefined();
  });
});
