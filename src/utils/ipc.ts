import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Socket } from 'node:net';
import { parse, stringify } from 'devalue';

export class LineIpc extends EventEmitter {
  constructor(private readonly socket: Socket) {
    super();

    socket.on('connect', () => this.emit('connect'));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.emit('close'));
    createInterface({ input: socket }).on('line', (line) => this.emit('message', parse(line)));
  }

  send(message: unknown): void {
    this.socket.write(stringify(message) + '\n');
  }

  close(): void {
    this.socket.end();
  }

  destroy(): void {
    this.socket.destroy();
  }
}
