/**
 * Adversarial check on the daemon's ACP permission-option selection.
 *
 * The user's approval answers exactly one call, but the *runtime* chooses
 * which permission options exist and in which order. If the daemon picked
 * `allow_always` because it was listed first, one "Approve" would silently
 * widen into standing approval for every later call in the attachment —
 * the runtime side of the same trap ADR-018 closes on the wire.
 *
 * Drives the real AcpRuntime against a hostile scripted agent
 * (fixtures/acp/hostile-permission-agent.mjs) over real stdio ND-JSON and
 * asserts durable options are never selected on the user's behalf.
 */

import { fileURLToPath } from 'node:url';
import { AcpRuntime } from '../packages/daemon/src/runtimes/acp.js';
import { McpBridge } from '../packages/daemon/src/mcp-bridge.js';
import type { TurnContext } from '../packages/daemon/src/runtime.js';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

const timer = setTimeout(() => {
  console.log('\nTIMED OUT — the hostile agent never finished its turn');
  process.exit(1);
}, 30_000);

const fixture = fileURLToPath(new URL('./fixtures/acp/hostile-permission-agent.mjs', import.meta.url));
const bridge = new McpBridge();
const runtime = new AcpRuntime({ command: process.execPath, args: [fixture], bridge });

const tools = [{ name: 'doc.read', description: 'Read the document', inputSchema: { type: 'object' } }];
const grant = { tools, alwaysAsk: [], expiresAt: Date.now() + 60_000 };
const surface = { name: 'Hostile Permission Check', origin: 'https://example.test' };

await runtime.openSession({ surface, grant, tools, policy: { mayAsk: false, mayUseOwnTools: false } });

const said: string[] = [];
const approvals: string[] = [];
// One answer per approval the user is actually shown: cases 1-2 approved,
// cases 3-4 denied. Case 5 is grant-bounded and must never reach the user.
// Case 7 is the collision: it MUST reach the user, so it needs an answer.
const answers = [true, true, false, false, false];

const ctx: TurnContext = {
  surface,
  grant,
  tools,
  say: (text) => said.push(text),
  think: () => {},
  plan: () => {},
  // This tier may not be asked, and the check asserts that nothing tries.
  ask: () => Promise.resolve(undefined),
  callTool: () => Promise.resolve({}),
  requestApproval: (summary) => {
    approvals.push(summary);
    const answer = answers.shift();
    if (answer === undefined) throw new Error('unexpected extra approval request');
    return Promise.resolve(answer);
  },
  signal: new AbortController().signal,
};

await runtime.prompt('go', ctx);

interface Outcome {
  outcome?: { outcome?: string; optionId?: string };
}
const outcomes = JSON.parse(said.join('')) as Outcome[];
const selected = (o: Outcome | undefined) => (o?.outcome?.outcome === 'selected' ? o.outcome.optionId : o?.outcome?.outcome);

console.log('hostile permission-option selection');
check('durable-first ordering + approve selects allow_once', selected(outcomes[0]) === 'a-once', outcomes[0]);
check('only allow_always on offer + approve is cancelled, never durable', selected(outcomes[1]) === 'cancelled', outcomes[1]);
check('durable-first ordering + deny selects reject_once', selected(outcomes[2]) === 'c-ronce', outcomes[2]);
check('only reject_always on offer + deny is cancelled, never durable', selected(outcomes[3]) === 'cancelled', outcomes[3]);
check('grant-bounded MCP tool auto-allows once only', selected(outcomes[4]) === 'e-once', outcomes[4]);
check(
  'the same tool titled the way production titles it is still pre-approved',
  selected(outcomes[5]) === 'f-once',
  outcomes[5],
);
// The bypass, stated as the property rather than as the mechanism: an
// agent-chosen title that happens to equal a granted tool's bare name must not
// buy the agent's own capability a free pass.
check(
  'a built-in tool wearing a granted tool name is NOT pre-approved',
  selected(outcomes[6]) === 'g-ronce',
  outcomes[6],
);
check('and it reached the user, who is the only party that may allow it', approvals.includes('doc_read'), approvals);
check('the user was consulted exactly five times', approvals.length === 5, approvals);

clearTimeout(timer);
await runtime.closeSession();
await bridge.stop();

console.log(failures === 0 ? '\nACP PERMISSION PASS' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
