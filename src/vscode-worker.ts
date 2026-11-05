import { init, runBaseTests, setupEnvironment } from 'vitest/worker';
import { once } from 'node:events';
import * as net from 'node:net';
import { LineIpc } from './utils/ipc';

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
    runTests: (state, traces) => runBaseTests('run', state, traces),
    collectTests: (state, traces) => runBaseTests('collect', state, traces)
  });

  await once(ipc, 'close');
}

