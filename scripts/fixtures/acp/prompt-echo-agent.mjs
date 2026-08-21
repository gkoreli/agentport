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
 * argv[2], when present, is a JSON object merged into the advertised
 * agentCapabilities, so one fixture can play a loadSession agent, a
 * sessionCapabilities.resume agent, or neither.
 */
import { createInterface } from 'node:readline';

const SESSION = 'sess-echo';
const extraCapabilities = process.argv[2] ? JSON.parse(process.argv[2]) : {};

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
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
    write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION } });
  } else if (msg.method === 'session/load') {
    // Only a loadSession agent replays. Advertising-honesty is the subject
    // under test, so an agent that never advertised it refuses like a real
    // one would rather than helpfully answering anyway.
    if (!extraCapabilities.loadSession) {
      write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'load not supported' } });
      return;
    }
    for (const update of [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } },
    ]) {
      write({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: SESSION, update } });
    }
    write({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    const text = msg.params?.prompt?.[0]?.text ?? '';
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      },
    });
    write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
  } else if (msg.id !== undefined) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
