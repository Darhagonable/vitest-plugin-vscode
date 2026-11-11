import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import { LineIpc } from '../../src/utils/ipc';

function createSocketPair(): Promise<{ a: LineIpc; b: LineIpc; close: () => void }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.on('error', reject);
      server.once('connection', connection => {
        resolve({
          a: new LineIpc(connection),
          b: new LineIpc(socket),
          close: () => {
            connection.destroy();
            socket.destroy();
            server.close();
          }
        });
      });
    });
    server.on('error', reject);
  });
}

describe('LineIpc', () => {
  let pair: Awaited<ReturnType<typeof createSocketPair>>;

  beforeEach(async () => {
    pair = await createSocketPair();
  });

  afterEach(() => {
    pair.close();
  });

  it('round-trips objects with Dates, Maps, and nested structures', async () => {
    const sent = {
      when: new Date('2026-01-01T00:00:00Z'),
      lookup: new Map([['key', 'value']]),
      nested: { list: [1, 2, 3], flag: null }
    };
    const received = new Promise<unknown>(resolve => pair.a.on('message', resolve));
    pair.b.send(sent);
    await expect(received).resolves.toEqual(sent);
  });

  it('delivers messages in send order', async () => {
    const received: unknown[] = [];
    const all = new Promise<void>(resolve => {
      pair.a.on('message', (message: unknown) => {
        received.push(message);
        if (received.length === 10) resolve();
      });
    });

    for (let i = 0; i < 10; i++) {
      pair.b.send({ i });
    }

    await all;
    expect(received).toEqual(Array.from({ length: 10 }, (_, i) => ({ i })));
  });

  it('reassembles a large message fragmented across TCP chunks', async () => {
    const big = { data: 'x'.repeat(1024 * 1024) };
    const received = new Promise<unknown>(resolve => pair.a.on('message', resolve));
    pair.b.send(big);
    await expect(received).resolves.toEqual(big);
  });

  it('carries messages in both directions simultaneously', async () => {
    const gotA = new Promise<unknown>(resolve => pair.a.on('message', resolve));
    const gotB = new Promise<unknown>(resolve => pair.b.on('message', resolve));

    pair.b.send({ from: 'b' });
    pair.a.send({ from: 'a' });

    await expect(gotA).resolves.toEqual({ from: 'b' });
    await expect(gotB).resolves.toEqual({ from: 'a' });
  });

  it('emits exit when the other end destroys the socket', async () => {
    const closed = new Promise<void>(resolve => pair.a.on('exit', resolve));
    pair.b.destroy();
    await closed;
  });

  it('emits exit on graceful end', async () => {
    const closed = new Promise<void>(resolve => pair.a.on('exit', resolve));
    pair.b.close();
    await closed;
  });
});
