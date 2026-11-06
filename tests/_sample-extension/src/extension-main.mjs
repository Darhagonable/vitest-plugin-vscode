// Real activation entry for the sample extension.
//
// By default it behaves like a healthy extension: it announces its
// activation with a real info toast and a log line.
//
// With SAMPLE_BROKEN=1 it mimics real-world misbehavior: it warns about an
// (imagined) unsupported setting via a warning toast, then loads a broken
// module — a genuine SyntaxError that fails activation with a stack trace.
import * as vscode from 'vscode';

export async function activate() {
  vscode.window.showInformationMessage('sample-extension: activated (info toast from a real activation)');
  console.info('sample-extension: activated');

  if (process.env.SAMPLE_BROKEN === '1') {
    vscode.window.showWarningMessage('sample-extension: unsupported setting "sample.experimental", falling back to defaults');
    console.warn('sample-extension: unsupported setting "sample.experimental", falling back to defaults');
    await import('./extension-broken.mjs');
  }
}

export function deactivate() {
  // nothing to clean up
}
