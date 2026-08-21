/**
 * Same loop as e2e.ts, but the brain is a real ACP agent (Claude Code by
 * default). Run this where the agent is authenticated — i.e. the VPS.
 *
 *   AGENTPORT_ACP_COMMAND=npx \
 *   AGENTPORT_ACP_ARGS="-y @agentclientprotocol/claude-agent-acp" \
 *   npx tsx scripts/acp-smoke.ts
 */

import { WebSocket as NodeWebSocket } from 'ws';
import { Relay } from '../packages/relay/src/relay.js';
import { AgentDaemon } from '../packages/daemon/src/daemon.js';
import { McpBridge } from '../packages/daemon/src/mcp-bridge.js';
import { AcpHost, AcpRuntime } from '../packages/daemon/src/runtimes/acp.js';
import { AgentWallet, type SiteTool } from '../packages/client/src/index.js';
import { Deferred, generateKeyPair } from '../packages/protocol/src/index.js';

const socketFactory = (url: string) => new NodeWebSocket(url) as never;
const doc = { text: 'The sea was calm that morning.' };
const calls: string[] = [];

const tools: SiteTool[] = [
  {
    name: 'inkwell.document.read',
    description: 'Read the full text of the document the user is editing',
    inputSchema: { type: 'object', properties: {} },
    handler: () => {
      calls.push('read');
      return { text: doc.text };
    },
  },
  {
    name: 'inkwell.document.append',
    description: 'Append a paragraph to the end of the document',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    handler: (args) => {
      calls.push('append');
      doc.text = `${doc.text}\n\n${String(args.text ?? '')}`;
      return { ok: true };
    },
  },
];

const relay = new Relay({ port: 0 });
await relay.listening();
const relayUrl = `ws://127.0.0.1:${relay.port}`;

const user = generateKeyPair();
const agentKeys = generateKeyPair();
const bridge = new McpBridge();
const acpHost = new AcpHost({
  command: process.env.AGENTPORT_ACP_COMMAND ?? 'npx',
  args: (process.env.AGENTPORT_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp')
    .split(' ')
    .filter(Boolean),
  cwd: process.env.AGENTPORT_AGENT_CWD ?? process.cwd(),
});
const pairingCode = new Deferred<string>();

const daemon = new AgentDaemon({
  relayUrl,
  identity: {
    secretKey: agentKeys.secretKey,
    publicKey: agentKeys.publicKey,
    name: "Goga's Writing Agent",
    runtime: 'claude-code',
    location: 'ggsCloud',
  },
  createRuntime: () => new AcpRuntime({ host: acpHost, bridge }),
  onPairingCode: (code) => pairingCode.resolve(code),
});

await daemon.start();
const wallet = new AgentWallet({ relayUrl, userSecretKey: user.secretKey, socketFactory });
await wallet.connect();
await wallet.approvePairing(await wallet.claimPairing(await pairingCode.promise));
console.log('paired\n');

const session = await wallet.openSession({
  agent: agentKeys.publicKey,
  surface: { name: 'Inkwell', route: '/documents/doc_123', origin: 'https://inkwell.test' },
  tools,
  decide: async (prompt) => {
    console.log(`[approval] ${prompt.summary} -> allow`);
    return true;
  },
});
console.log(`session open with ${session.info.agentName} (${session.info.runtime})\n`);

session.on('thought', (event) => process.stdout.write(`\x1b[2m${event.text}\x1b[0m`));
session.on('tool', (event) => console.log(`\n[tool] ${event.name} ok=${event.ok}`));

const reply = await session.prompt(
  'Read the document, then append exactly one more sentence continuing the story. Keep it short.',
);

console.log(`\n\n--- reply ---\n${reply}`);
console.log(`\n--- document ---\n${doc.text}`);
console.log(`\n--- tools called: ${calls.join(', ') || 'none'} ---`);

const ok = calls.includes('read') && calls.includes('append') && doc.text.split('\n\n').length > 1;
console.log(ok ? '\nSMOKE PASS: a real agent used the site tools' : '\nSMOKE FAIL');

session.close();
wallet.close();
await daemon.stop();
await bridge.stop();
await relay.close();
process.exit(ok ? 0 : 1);
