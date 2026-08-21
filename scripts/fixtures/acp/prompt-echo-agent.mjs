/**
 * Scripted ACP agent for scripts/acp-runtime-check.ts.
 *
 * Echoes every `session/prompt` text back as one agent_message_chunk, so the
 * harness can read EXACTLY what the runtime put in front of the model —
 * which is the subject under test: the preamble, its context channels, and
 * their untrusted-data framing. It deliberately never dials the MCP servers
 * it is handed, which makes it double as the "agent whose MCP client never
 * connected" case for the bridge-health section.
 *
 * MULTI-SESSION, because the shared-process host is now the production shape:
 * `session/new` mints a distinct id per call, every update carries the id of
 * the session that asked, and `session/load` replays into the requesting
 * session only. A fixture that conflated sessions would make correct host
 * routing indistinguishable from broken routing.
 *
 * Two observation channels for the host checks:
 *   - AGENTPORT_ECHO_SPAWN_LOG: a file this process appends `${pid}\n` to at
 *     startup, so a check can count spawns without parsing output formats.
 *   - a prompt beginning `[hold]` does not answer until session/cancel for
 *     that session arrives (or 2s passes) — the cancellation-isolation case.
 *
 * argv[2], when present, is a JSON object merged into the advertised
 * agentCapabilities, so one fixture can play a loadSession agent, a
 * sessionCapabilities.resume agent, or neither.
 */
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const extraCapabilities = process.argv[2] ? JSON.parse(process.argv[2]) : {};
if (process.env.AGENTPORT_ECHO_SPAWN_LOG) {
  appendFileSync(process.env.AGENTPORT_ECHO_SPAWN_LOG, `${process.pid}\n`);
}

let sessions = 0;
/** elicitation request id -> deliver the client's response. */
const pendingElicits = new Map();
/** sessionId -> answer a held prompt now (cancel arrived or timer fired). */
const held = new Map();

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.method === undefined && typeof msg.id === 'string' && pendingElicits.has(msg.id)) {
    const deliver = pendingElicits.get(msg.id);
    pendingElicits.delete(msg.id);
    deliver(msg.result);
    return;
  }
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        agentCapabilities: { loadSession: false, ...extraCapabilities },
      },
    });
  } else if (msg.method === 'session/new') {
    write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: `sess-echo-${++sessions}` } });
  } else if (msg.method === 'session/load') {
    // Only a loadSession agent replays. Advertising-honesty is the subject
    // under test, so an agent that never advertised it refuses like a real
    // one would rather than helpfully answering anyway.
    if (!extraCapabilities.loadSession) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'load not supported' } });
      return;
    }
    const sessionId = msg.params.sessionId;
    for (const update of [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } },
    ]) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    }
    write({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const sessionId = msg.params.sessionId;
    const text = msg.params?.prompt?.[0]?.text ?? '';
    const answer = (stopReason) => {
      write({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
        },
      });
      write({ jsonrpc: '2.0', id: msg.id, result: { stopReason } });
    };
    if (text.includes('[ask]')) {
      // Ask the client a question and echo what came back, so a check can
      // read WHICH answer the elicitation path produced for this session.
      const id = `elicit-${sessionId}`;
      pendingElicits.set(id, (result) => {
        write({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ask:${result?.action ?? 'none'}` } },
          },
        });
        write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      });
      write({
        jsonrpc: '2.0',
        id,
        method: 'elicitation/create',
        params: {
          sessionId,
          mode: 'form',
          message: 'which draft?',
          requestedSchema: { type: 'object', properties: { draft: { type: 'string', title: 'Draft' } } },
        },
      });
      return;
    }
    if (text.includes('[hold]')) {
      // Bounded: an un-cancelled hold answers by itself, so a broken cancel
      // path fails an assertion instead of hanging the whole check.
      const timer = setTimeout(() => {
        held.delete(sessionId);
        answer('end_turn');
      }, 2_000);
      held.set(sessionId, () => {
        clearTimeout(timer);
        answer('cancelled');
      });
      return;
    }
    answer('end_turn');
  } else if (msg.method === 'session/cancel') {
    // Written to the observation file so a check can assert a cancel reached
    // EXACTLY the session it was aimed at — misrouting is invisible from the
    // answers alone when the other session was never held.
    if (process.env.AGENTPORT_ECHO_SPAWN_LOG) {
      appendFileSync(process.env.AGENTPORT_ECHO_SPAWN_LOG, `cancel ${msg.params.sessionId}\n`);
    }
    const release = held.get(msg.params.sessionId);
    held.delete(msg.params.sessionId);
    if (release) release();
  } else if (msg.id !== undefined) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
