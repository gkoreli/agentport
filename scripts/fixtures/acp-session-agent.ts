/** Minimal real ACP subprocess used by the attachment-identity regression. */

import { Readable, Writable } from 'node:stream';
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';

agent({ name: 'agentport-session-test' })
  .onRequest(methods.agent.initialize, () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
  }))
  .onRequest(methods.agent.session.new, () => ({ sessionId: `fixture-${process.pid}` }))
  // Accepting any id deliberately makes the old surface-key heuristic appear
  // to work, so the parent regression fails if that legacy path returns.
  .onRequest(methods.agent.session.load, () => ({}))
  .onRequest(methods.agent.session.prompt, () => ({ stopReason: 'end_turn' }))
  .connect(ndJsonStream(
    Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
  ));
