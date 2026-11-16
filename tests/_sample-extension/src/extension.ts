import * as vscode from 'vscode';

export const commandId = 'sample-extension.helloWorld';

export function activate(context: vscode.ExtensionContext): void {
  console.log('The sample extension is now active!');

  const disposable = vscode.commands.registerCommand(commandId, () => {
    vscode.window.showInformationMessage('Hello from the sample extension!');
  });

  context.subscriptions.push(disposable);
}

export function deactivate() {
  console.log('The sample extension is now deactivated!');
}
