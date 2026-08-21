/** Minimal real ACP subprocess used by the attachment-identity regression. */

import { Readable, Writable } from 'node:stream';
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';

agent({ name: 'agentport-session-test' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
  }))
  // Distinct id per session, as every real agent mints: under the shared
  // process two attachments land in ONE fixture, and a fixture that returned
  // the same id twice would collide in the host's routing table rather than
  // exercising the property this regression exists for.
  .onRequest(methods.agent.session.new, (() => { let n = 0; return () => ({ sessionId: `fixture-${process.pid}-${++n}` }); })())
  // Accepting any id deliberately makes the old surface-key heuristic appear
  // to work, so the parent regression fails if that legacy path returns.
  .onRequest(methods.agent.session.load, () => ({}))
  .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }))
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ));
