import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { Socket } from 'node:net';
import { parse, stringify } from 'devalue';

export class Ipc extends EventEmitter {
  constructor(private readonly socket: Socket) {
    super();

    socket.on('connect', () => this.emit('connect'));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.emit('exit'));
    createInterface({ input: socket }).on('line', (line) => this.emit('message', parse(line)));
  }

  send(message: unknown) {
    this.socket.write(stringify(message) + '\n');
  }

  close() {
    this.socket.end();
  }

  destroy() {
    this.socket.destroy();
  }
}
