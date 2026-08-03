import { WebSocketServer, type WebSocket } from 'ws';
import { encodeFrame, randomId, type Frame } from '@agentport/protocol';
import { RelayCore, type Peer } from './core.js';

export interface RelayOptions {
  port?: number;
  host?: string;
  log?: (message: string) => void;
  /** Test seam for proving edge checks against a relay with a dishonest clock. */
  now?: () => number;
}

/**
 * Node host for {@link RelayCore}. Owns sockets and nothing else — the relay
 * is stateless (ADR-016): certs are verified per connection, sessions are
 * daemon-authoritative, and a restart loses only sockets.
 */
export class Relay {
  readonly core: RelayCore;

  #wss: WebSocketServer;
  #peers = new Map<WebSocket, Peer>();

  constructor(options: RelayOptions = {}) {
    this.core = new RelayCore({
      log: options.log ?? (() => {}),
      now: options.now,
    });

    this.#wss = new WebSocketServer({ port: options.port ?? 8787, host: options.host ?? '127.0.0.1' });
    this.#wss.on('connection', (socket) => this.#onConnection(socket));
  }

  get port(): number {
    const address = this.#wss.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  async listening(): Promise<void> {
    if (this.#wss.address()) return;
    await new Promise<void>((resolve, reject) => {
      this.#wss.once('listening', resolve);
      this.#wss.once('error', reject);
    });
  }

  async close(): Promise<void> {
    for (const socket of this.#peers.keys()) socket.close();
    await new Promise<void>((resolve, reject) =>
      this.#wss.close((err) => (err ? reject(err) : resolve())),
    );
  }

  #onConnection(socket: WebSocket): void {
    const peer: Peer = {
      send: (frame: Frame) => {
        if (socket.readyState === socket.OPEN) socket.send(encodeFrame(frame));
      },
      close: () => socket.close(),
    };
    this.#peers.set(socket, peer);
    this.core.open(peer);

    socket.on('message', (data) => this.core.message(peer, data.toString()));
    const done = () => {
      if (!this.#peers.delete(socket)) return;
      this.core.close(peer);
    };
    socket.on('close', done);
    socket.on('error', done);
  }
}

export function newSessionId(): string {
  return randomId('sess_');
}
