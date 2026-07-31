import { encodeFrame, type AgentCert, type Frame } from '@agentport/protocol';
import { MemoryCertIndex, RelayCore, type Peer } from '@agentport/relay/core';

/**
 * The relay, as a Durable Object.
 *
 * Same `RelayCore` as the Node relay — pairing, ownership checks and routing
 * are shared code, so the hosted deployment cannot be more permissive than the
 * one you run yourself. The only things this file owns are sockets and
 * durability.
 *
 * Deliberately NOT using the hibernation API: sessions, pending pairings and
 * presence are in-memory and must outlive individual messages. The DO stays
 * resident while any socket is open, which is exactly the lifetime we want.
 */
export class RelayDurableObject implements DurableObject {
  #state: DurableObjectState;
  #core: RelayCore | undefined;
  #peers = new Map<WebSocket, Peer>();

  constructor(state: DurableObjectState) {
    this.#state = state;
    state.blockConcurrencyWhile(async () => {
      const stored = ((await state.storage.get<AgentCert[]>('certs')) ?? []) as AgentCert[];
      this.#core = new RelayCore({
        certs: new MemoryCertIndex(stored),
        onCertStored: () => void this.#persist(),
        log: (message) => console.log(`[relay] ${message}`),
      });
    });
  }

  async #persist(): Promise<void> {
    const certs = this.#core?.certs as MemoryCertIndex | undefined;
    if (certs) await this.#state.storage.put('certs', certs.all());
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const core = this.#core!;
    const peer: Peer = {
      send: (frame: Frame) => {
        try {
          server.send(encodeFrame(frame));
        } catch {
          // socket already gone; close() will clean up
        }
      },
      close: () => server.close(1000, 'closed by relay'),
    };
    this.#peers.set(server, peer);
    core.open(peer);

    server.addEventListener('message', (event: MessageEvent) => {
      if (typeof event.data === 'string') core.message(peer, event.data);
    });
    const done = () => {
      if (!this.#peers.delete(server)) return;
      core.close(peer);
    };
    server.addEventListener('close', done);
    server.addEventListener('error', done);

    return new Response(null, { status: 101, webSocket: client });
  }
}
