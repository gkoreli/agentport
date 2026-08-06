import { WebSocketServer, type WebSocket } from 'ws';
import {
  MAX_FRAME_CHARS,
  createLogger,
  encodeFrame,
  randomId,
  type Frame,
  type Logger,
  type LogSink,
} from '@agentport/protocol';
import { RelayCore, type Peer } from './core.js';

export interface RelayOptions {
  port?: number;
  host?: string;
  sink?: LogSink;
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
  #log: Logger;

  constructor(options: RelayOptions = {}) {
    this.#log = createLogger('relay.socket', { sink: options.sink });
    this.core = new RelayCore({ sink: options.sink, now: options.now });

    this.#wss = new WebSocketServer({
      port: options.port ?? 8787,
      host: options.host ?? '127.0.0.1',
      // ws defaults to 100 MiB, which would let a peer buffer 100 MB into
      // relay memory before decodeFrame ever ran. Cap at the protocol frame
      // bound — the same ceiling the hosted relay inherits from Cloudflare's
      // message cap — so the self-hosted relay is no more permissive.
      // decodeFrame's char cap stays as the inner guard (chars ≤ UTF-8 bytes).
      maxPayload: MAX_FRAME_CHARS,
    });
    this.#wss.on('connection', (socket) => this.#onConnection(socket));
    this.#wss.on('error', (err) => this.#log.error('websocket server failed', { err }));
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
        if (socket.readyState !== socket.OPEN) return;
        try {
          socket.send(encodeFrame(frame));
        } catch (err) {
          this.#log.error('websocket send failed', { err, data: { frameType: frame.t } });
        }
      },
      close: () => socket.close(),
    };
    this.#peers.set(socket, peer);
    this.core.open(peer);

    // Text frames only, matching the Worker host (which ignores non-string
    // messages): silently stringifying binary would give the Node relay a
    // second, host-specific way to spell the same frame.
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#log.warn('dropping binary websocket message', { data: { bytes: (data as Buffer).length } });
        return;
      }
      this.core.message(peer, data.toString());
    });
    const done = () => {
      if (!this.#peers.delete(socket)) return;
      this.core.close(peer);
    };
    socket.on('close', done);
    socket.on('error', (err) => {
      this.#log.error('websocket peer failed', { err });
      done();
    });
  }
}

export function newSessionId(): string {
  return randomId('sess_');
}
