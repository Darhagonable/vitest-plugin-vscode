import { Xvfb } from 'xvfb-ts';
import { spawnSync } from 'node:child_process';

const headless = process.platform === 'linux' && !process.env.DISPLAY;

let users = 0;
let xvfb: Promise<Xvfb> | undefined;

export async function withXvfb<T>(run: (display: string | undefined) => Promise<T>): Promise<T> {
  if (!headless)
    return run(undefined);

  if (!xvfb) {
    if (spawnSync('which', ['Xvfb']).status !== 0)
      throw new Error('VS Code needs an X server to run. Install Xvfb (e.g. apt-get install xvfb) or run on a machine with a display.');

    const server = new Xvfb();
    xvfb = server.start().then(() => server);
  }

  const server = await xvfb;
  users++;

  try {
    return await run(server.display());
  } finally {
    users--;
    if (users === 0) {
      await server.stop().catch(() => undefined);
      xvfb = undefined;
    }
  }
}
