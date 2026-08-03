import { createLogger, encodeFrame, type Frame } from '@agentport/protocol';
import { RelayCore, type Peer } from '@agentport/relay/core';

/**
 * The relay, as a Durable Object.
 *
 * Same `RelayCore` as the Node relay — pairing, ownership checks and routing
 * are shared code, so the hosted deployment cannot be more permissive than the
 * one you run yourself. This file owns sockets, full stop: the relay is
 * stateless (ADR-016). No storage API is touched — certs are verified per
 * connection and sessions are the daemon's to remember, so a redeploy loses
 * nothing that both ends cannot re-establish themselves.
 *
 * Deliberately NOT using the hibernation API: pending pairings and presence
 * are in-memory and must outlive individual messages. The DO stays resident
 * while any socket is open, which is exactly the lifetime we want.
 */
export class RelayDurableObject implements DurableObject {
  #core: RelayCore;
  #peers = new Map<WebSocket, Peer>();
  #log = createLogger('relay.worker');

  constructor(_state: DurableObjectState) {
    this.#core = new RelayCore();
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const core = this.#core;
    const peer: Peer = {
      send: (frame: Frame) => {
        try {
          server.send(encodeFrame(frame));
        } catch (err) {
          // socket already gone; close() will clean up
          this.#log.debug('could not send to a closed websocket', { err, data: { frameType: frame.t } });
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
