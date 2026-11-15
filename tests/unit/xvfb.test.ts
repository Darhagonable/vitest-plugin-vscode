import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { withXvfb } from '../../src/utils/xvfb';

// These tests run exactly where the feature activates: displayless Linux.
const headless = process.platform === 'linux' && !process.env.DISPLAY;

// The lock file's first line is the server's pid; the process dying is the
// cleanup invariant, the lock file itself is removed on the X server's own
// schedule.
const serverPid = (display: string) => Number.parseInt(readFileSync(`/tmp/.X${display.slice(1)}-lock`, 'utf8'), 10);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!headless)('withXvfb', () => {
  it('runs with its own display and cleans up after', async () => {
    let pid = 0;

    const used = await withXvfb((given) => {
      if (given)
        pid = serverPid(given);
      return Promise.resolve(given);
    });

    expect(used).toMatch(/^:\d+$/);

    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(false);
  });

  it('shares one display and keeps it until the last bracket finishes', async () => {
    let pid = 0;

    const short = withXvfb((given) => {
      if (given)
        pid = serverPid(given);
      return new Promise<string | undefined>(resolve => setTimeout(() => resolve(given), 50));
    });
    const long = withXvfb(given => new Promise<string | undefined>(resolve => setTimeout(() => resolve(given), 300)));

    const first = await short;
    expect(first).toMatch(/^:\d+$/);

    // The short bracket is done; the long one still holds the server.
    expect(alive(pid)).toBe(true);

    await expect(long).resolves.toBe(first);

    await new Promise(resolve => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(false);
  });

  it('fails with an install hint when Xvfb is missing', async () => {
    const path = process.env.PATH;
    process.env.PATH = '';

    try {
      await expect(withXvfb(() => Promise.resolve())).rejects.toThrow('Install Xvfb');
    } finally {
      process.env.PATH = path;
    }
  });
});
