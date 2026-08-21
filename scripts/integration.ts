/**
 * Full-stack integration test. No doubles anywhere.
 *
 *   real deployed relay (Cloudflare Durable Object)
 *   real drop-in connect flow (keyless client, connect.begin/accept)
 *   real ACP agent (claude-agent-acp -> Claude Code) unless overridden
 *   real MCP bridge serving the surface's tools
 *
 * This is the test that reproduces what a person actually does in a browser.
 * `ui-smoke.ts` uses a socket double on purpose — it is a DOM unit test and
 * must not need a network. This one is the opposite: it is worthless unless
 * everything is genuine.
 *
 *   npm run integration                          # deployed relay + Claude
 *   AGENTPORT_RUNTIME=demo-writer npm run integration
 *   AGENTPORT_RELAY=ws://127.0.0.1:8787 npm run integration
 */

import { WebSocket as NodeWebSocket } from 'ws';
import { AgentDaemon } from '../packages/daemon/src/daemon.js';
import { McpBridge } from '../packages/daemon/src/mcp-bridge.js';
import { AcpHost, AcpRuntime } from '../packages/daemon/src/runtimes/acp.js';
import { RUNTIMES, type AgentRuntime } from '../packages/daemon/src/runtime.js';
import { AgentWallet, type SiteTool } from '../packages/client/src/index.js';
import { generateKeyPair } from '../packages/protocol/src/index.js';

const relayUrl = process.env.AGENTPORT_RELAY ?? 'wss://agentport.gogakoreli.workers.dev/relay';
const runtimeName = process.env.AGENTPORT_RUNTIME ?? 'claude-code';
const timeoutMs = Number(process.env.AGENTPORT_TIMEOUT ?? 180_000);

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// --- the surface -----------------------------------------------------------

const doc = { text: 'The sea was calm that morning.' };
const called: string[] = [];

const tools: SiteTool[] = [
  {
    name: 'inkwell.document.read',
    description: 'Read the current document',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      called.push('read');
      return { text: doc.text };
    },
  },
  {
    name: 'inkwell.document.append',
    description: 'Append a paragraph to the end of the document',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Paragraph to append' } },
      required: ['text'],
    },
    handler: (args) => {
      called.push('append');
      doc.text = `${doc.text}\n\n${String(args.text ?? '')}`;
      return { ok: true };
    },
  },
];

// --- the agent side --------------------------------------------------------

const bridge = new McpBridge();
const keys = generateKeyPair();
const approvals: string[] = [];

let sharedHost: AcpHost | undefined;
const acpHost = (): AcpHost =>
  (sharedHost ??= new AcpHost({
    command: process.env.AGENTPORT_ACP_COMMAND ?? 'npx',
    args: (process.env.AGENTPORT_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp')
      .split(' ')
      .filter(Boolean),
    cwd: process.env.AGENTPORT_AGENT_CWD ?? process.cwd(),
  }));

const createRuntime = (): AgentRuntime => {
  const known = RUNTIMES[runtimeName];
  if (known) return known();
  return new AcpRuntime({ host: acpHost(), bridge });
};

const daemon = new AgentDaemon({
  relayUrl,
  identity: { ...keys, name: 'Integration Agent', runtime: runtimeName, location: 'test' },
  createRuntime,
  onConnectOffer: async () => true,
  onLocalApproval: async (summary) => {
    approvals.push(summary);
    return true;
  },
});

// --- run -------------------------------------------------------------------

console.log(`relay:   ${relayUrl}`);
console.log(`runtime: ${runtimeName}\n`);

const timer = setTimeout(() => {
  console.log(`\nTIMED OUT after ${timeoutMs}ms — the agent never finished its turn`);
  process.exit(1);
}, timeoutMs);

console.log('1. agent connects');
await daemon.start();
check('daemon reached the relay', true);

console.log('\n2. a keyless page asks for an agent');
const pageKeys = generateKeyPair();
const page = new AgentWallet({
  relayUrl,
  userSecretKey: pageKeys.secretKey,
  socketFactory: (url) => new NodeWebSocket(url) as never,
});
await page.connect();
check('page has no agents of its own', (await page.listAgents()).length === 0);

const { code, accepted } = await page.beginConnect({
  surface: { name: 'Inkwell', route: '/documents/doc_123', origin: 'https://agentport.gogakoreli.workers.dev' },
  tools,
  decide: () => true,
});
check('relay issued a connect code', /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code), code);

daemon.claimConnect(code);
const session = await accepted;
check('session opened', session.info.agentName === 'Integration Agent', session.info);
check('grant carries both tools', session.grant.tools.length === 2);

console.log('\n3. conversation');
const streamed: string[] = [];
session.on('delta', (event) => streamed.push(event.text));
session.on('thought', (event) => console.log(`      ${event.text.trim().slice(0, 100)}`));
session.on('tool', (event) => console.log(`      [tool] ${event.name} ok=${event.ok}${event.ok ? '' : ` (${event.error})`}`));

const reply = await session.prompt(
  'Read the document, then append exactly one short sentence continuing it. Do not ask questions.',
);

check('the agent replied with text', reply.trim().length > 0, reply.slice(0, 200));
check('it read the document', called.includes('read'), called);
check('it wrote through the site tool', called.includes('append'), called);
check('the document changed', doc.text.split('\n\n').length > 1, doc.text);

console.log('\n4. refresh: drop the client, re-attach, restore from the agent');
// Simulate a page reload: the tab's socket dies, a fresh wallet instance
// restores the bounded attachment identity and picks the conversation back up.
const token = page.resumeTokenFor(session.id);
check('relay issued a resume token', typeof token === 'string' && token.length > 0);

// A REAL refresh starts the new page's resume while the old tab's socket is
// still closing — the relay briefly answers already_attached and the wallet
// must retry through it. Reproduce that: begin the resume first, and only
// drop the old socket a moment later. (An earlier version of this test
// politely disconnected and slept 600ms first, which is exactly why it
// missed the bug that lost every real refresh.)
const reloaded = new AgentWallet({
  relayUrl,
  userSecretKey: pageKeys.secretKey,
  socketFactory: (url) => new NodeWebSocket(url) as never,
});
await reloaded.connect();
const resuming = reloaded.resumeSession({
  id: session.id,
  agent: keys.publicKey,
  token: token!,
  tools,
  decide: () => true,
});
setTimeout(() => page.disconnect(), 1000);
const { session: resumed } = await resuming;
check('the resumed session is sealed again', Boolean(resumed.info.verify), resumed.info);
check('session survived the refresh', resumed.info.agentName === 'Integration Agent', resumed.info);

const history = await resumed.history();
check('history came back from the agent', history.length > 0, history.length);
check(
  'it contains the actual conversation',
  history.some((entry) => entry.role === 'agent' && entry.text.trim().length > 0),
  history.slice(0, 3),
);
console.log(`      restored ${history.length} entries from the agent's own store`);

const second = await resumed.prompt('In one short sentence, what did you just append?');
check('the agent still remembers the thread', second.trim().length > 0, second.slice(0, 160));
console.log(`      follow-up: ${second.trim().slice(0, 160)}`);

console.log(`\n--- reply ---\n${reply.trim().slice(0, 400)}`);
console.log(`\n--- document ---\n${doc.text}`);

clearTimeout(timer);
resumed.close();
reloaded.close();
await daemon.stop();
await bridge.stop();

console.log(failures === 0 ? '\nINTEGRATION PASS' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
