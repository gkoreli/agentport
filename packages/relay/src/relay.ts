import { WebSocketServer, type WebSocket } from 'ws';
import { encodeFrame, randomId, type Frame } from '@agentport/protocol';
import { RelayCore, MemoryCertIndex, type Peer } from './core.js';
import { CertStore } from './store.js';

export interface RelayOptions {
  port?: number;
  host?: string;
  storePath?: string;
  log?: (message: string) => void;
}

/**
 * Node host for {@link RelayCore}. Owns sockets and the file-backed cert
 * store; every decision about who may talk to whom lives in the core.
 */
export class Relay {
  readonly certs: CertStore;
  readonly core: RelayCore;

  #wss: WebSocketServer;
  #peers = new Map<WebSocket, Peer>();

  constructor(options: RelayOptions = {}) {
    this.certs = new CertStore(options.storePath);
    this.core = new RelayCore({
      certs: new MemoryCertIndex(this.certs.all()),
      onCertStored: (cert) => this.certs.put(cert),
      log: options.log ?? (() => {}),
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
