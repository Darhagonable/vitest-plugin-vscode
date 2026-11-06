import { init, runBaseTests, setupEnvironment } from 'vitest/worker';
import { once } from 'node:events';
import * as net from 'node:net';
import * as path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { LineIpc } from './utils/ipc';

/** Byte offset up to which the extension host log has been consumed. */
let logOffset = 0;

export async function run() {
  const port = Number(process.env.VITEST_RUNNER_IPC_PORT);
  const host = process.env.VITEST_RUNNER_IPC_HOST || '127.0.0.1';

  if (!Number.isInteger(port) || port <= 0)
    throw new Error('Missing VITEST_RUNNER_IPC_PORT for Vitest VS Code bridge.');

  const ipc = new LineIpc(net.connect({ host, port }));
  await once(ipc, 'connect');

  init({
    on: (callback) => ipc.on('message', callback),
    off: (callback) => ipc.off('message', callback),
    post: (data) => ipc.send(data),
    setup: setupEnvironment,
    runTests: async (state, traces) => {
      const result = await runBaseTests('run', state, traces);
      await failOnExthostErrors();
      return result;
    },
    collectTests: async (state, traces) => {
      const result = await runBaseTests('collect', state, traces);
      await failOnExthostErrors();
      return result;
    }
  });

  await once(ipc, 'close');
}

/**
 * Fails the run when the extension host logged errors.
 *
 * Every error path in VS Code terminates in `logService.error(...)`,
 * which an in-process spdlog appender writes to `exthost.log`: activation
 * failures, crashes in event handlers, uncaught exceptions and (about a
 * second late) unhandled rejections. The pool pins the log directory via
 * `--logsPath`; the byte offset ensures watch-mode reruns only report
 * entries that are new.
 */
async function failOnExthostErrors() {
  const logFile = await findExthostLog(process.env.VSCODE_RUNNER_LOGS_DIR);
  if (!logFile)
    return;

  const content = await readFile(logFile, 'utf8').catch(() => '');

  // Only consume up to the last complete line — the log may be mid-write.
  const end = content.lastIndexOf('\n') + 1;
  const fresh = content.slice(logOffset, end);
  logOffset = end;

  // An entry is an `[error]`-tagged line plus every continuation line that
  // does not start a new entry (stack traces and other multi-line output).
  const errors = fresh.match(/^\d{4}-\d{2}-\d{2} [\d:.]+ \[error\] .*(?:\n(?!^\d{4}-\d{2}-\d{2}).*)*/gm);

  if (errors?.length) {
    const debug = process.env.VSCODE_RUNNER_DEBUG_LOGS ? `\n\n[vscode] raw log (${logFile}):\n${fresh}` : '';
    const stripped = errors.map(entry => entry.replace(/^\d{4}-\d{2}-\d{2} [\d:.]+ \[error\] /, ''));
    const error = new Error(`VS Code extension host reported errors:\n\n${stripped.map(trimExtensionHostFrames).join('\n\n')}${debug}`);
    // The entries already contain VS Code's own stack; dropping the
    // runner-side frames keeps the printed error on the crash site.
    error.stack = '';
    throw error;
  }
}

/** Finds `exthost.log` under the pinned logs root (one session lives there). */
async function findExthostLog(dir: string | undefined): Promise<string | undefined> {
  if (!dir)
    return undefined;

  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findExthostLog(full);
      if (found)
        return found;
    }
    else if (entry.isFile() && entry.name === 'exthost.log') {
      return full;
    }
  }
  return undefined;
}

/**
 * Drops Node builtin (`node:`) frames and extension host internals from a
 * log entry, so the reported stack ends at the frame in the extension's
 * own code instead of loaders and VS Code's bootstrap.
 */
function trimExtensionHostFrames(text: string): string {
  return text
    .split('\n')
    .filter(line =>
      !/^\s*at\s/.test(line)
      || (!line.includes('node:') && !line.includes('extensionHostProcess.js'))
    )
    .join('\n');
}
