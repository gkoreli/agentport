/**
 * Hostile ACP agent for scripts/acp-permission-check.ts.
 *
 * Speaks just enough ND-JSON JSON-RPC to open a session and, during the one
 * prompt, issue permission requests whose option order and kinds are chosen
 * adversarially. The runtime controls both, so the daemon must never let
 * ordering pick a durable (allow_always / reject_always) option the user
 * only answered once for. The collected responses are streamed back to the
 * test as one agent_message_chunk of JSON.
 */
import { createInterface } from 'node:readline';

const SESSION = 'sess-hostile';
const pending = new Map();
let nextId = 1000;

const write = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    write({ jsonrpc: '2.0', id, method, params });
  });

async function runPrompt() {
  const outcomes = [];
  const permission = async (toolCall, options) => {
    outcomes.push(await request('session/request_permission', { sessionId: SESSION, toolCall, options }));
  };

  // 1. Durable option listed first; the user will approve once.
  await permission({ toolCallId: 't1', title: 'Run a shell command' }, [
    { optionId: 'a-always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'a-once', name: 'Allow once', kind: 'allow_once' },
  ]);
  // 2. Only a durable option on offer; the user will approve once.
  await permission({ toolCallId: 't2', title: 'Run a shell command' }, [
    { optionId: 'b-always', name: 'Always allow', kind: 'allow_always' },
  ]);
  // 3. Durable rejection listed first; the user will deny once.
  await permission({ toolCallId: 't3', title: 'Delete a file' }, [
    { optionId: 'c-ralways', name: 'Always reject', kind: 'reject_always' },
    { optionId: 'c-ronce', name: 'Reject once', kind: 'reject_once' },
    { optionId: 'c-aonce', name: 'Allow once', kind: 'allow_once' },
  ]);
  // 4. Only a durable rejection on offer; the user will deny once.
  await permission({ toolCallId: 't4', title: 'Delete a file' }, [
    { optionId: 'd-ralways', name: 'Always reject', kind: 'reject_always' },
  ]);
  // 5. A grant-bounded AgentPort MCP tool: auto-allowed once, never durably,
  //    and without consulting the user at all.
  await permission({ toolCallId: 't5', title: 'doc.read', name: 'mcp__agentport__doc_read' }, [
    { optionId: 'e-always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'e-once', name: 'Allow once', kind: 'allow_once' },
  ]);

  write({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: SESSION,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(outcomes) } },
    },
  });
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    pending.get(msg.id)?.(msg.result ?? { error: msg.error });
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: msg.params.protocolVersion, agentCapabilities: { loadSession: false } },
    });
  } else if (msg.method === 'session/new') {
    write({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION } });
  } else if (msg.method === 'session/prompt') {
    runPrompt().then(
      () => write({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } }),
      (err) => write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(err) } }),
    );
  } else if (msg.id !== undefined) {
    write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
  }
});
