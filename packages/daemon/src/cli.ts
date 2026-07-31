import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AgentDaemon } from './daemon.js';
import { loadIdentity, saveIdentity } from './identity.js';
import { RUNTIMES, registerRuntime } from './runtime.js';
import { McpBridge } from './mcp-bridge.js';
import { AcpRuntime } from './runtimes/acp.js';

// One bridge per daemon; each session gets its own token-scoped endpoint on it.
const bridge = new McpBridge();

const acpLog = (m: string) => console.log(`[acp] ${m}`);

registerRuntime(
  'claude-code',
  () =>
    new AcpRuntime({
      command: process.env.AGENTPORT_ACP_COMMAND ?? 'npx',
      args: (process.env.AGENTPORT_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp').split(' '),
      cwd: process.env.AGENTPORT_AGENT_CWD ?? process.cwd(),
      bridge,
      log: acpLog,
    }),
);

// Any ACP agent at all: AGENTPORT_ACP_COMMAND=goose AGENTPORT_ACP_ARGS=acp
registerRuntime(
  'acp',
  () =>
    new AcpRuntime({
      command: process.env.AGENTPORT_ACP_COMMAND ?? 'npx',
      args: (process.env.AGENTPORT_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp').split(' ').filter(Boolean),
      cwd: process.env.AGENTPORT_AGENT_CWD ?? process.cwd(),
      bridge,
      log: acpLog,
    }),
);

const relayUrl = process.env.AGENTPORT_RELAY ?? 'ws://127.0.0.1:8787';
const walletUrl = process.env.AGENTPORT_WALLET ?? 'http://127.0.0.1:8788/pair';
const identityPath = process.env.AGENTPORT_IDENTITY ?? join(homedir(), '.agentport', 'agent.json');
const runtimeName = process.env.AGENTPORT_RUNTIME ?? 'demo-writer';

const createRuntime = RUNTIMES[runtimeName];
if (!createRuntime) {
  console.error(`unknown runtime "${runtimeName}"; known: ${Object.keys(RUNTIMES).join(', ')}`);
  process.exit(1);
}

const identity = loadIdentity(identityPath, {
  name: process.env.AGENTPORT_NAME ?? "Goga's Writing Agent",
  runtime: runtimeName,
  location: process.env.AGENTPORT_LOCATION ?? 'Personal VPS',
});

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => resolve(/^y(es)?$/i.test(answer.trim())));
  });
}

const daemon = new AgentDaemon({
  relayUrl,
  identity,
  createRuntime,
  log: (m) => console.log(`[agent] ${m}`),
  onPairingCode: (code) => {
    console.log('');
    console.log('  Your agent is ready to pair:');
    console.log('');
    console.log(`    ${walletUrl}#code=${code}`);
    console.log('');
    console.log(`  Code: ${code}`);
    console.log('');
  },
  // The consent moment for drop-in sites. It happens here, in your terminal,
  // because this is where your key is — the website asking is holding an
  // ephemeral keypair with no authority whatsoever.
  onConnectOffer: async ({ surface, grant }) => {
    const gated = new Set([...grant.alwaysAsk, ...grant.tools.filter((t) => t.requiresApproval).map((t) => t.name)]);
    console.log('');
    console.log(`  ${surface.name} (${surface.origin}${surface.route ?? ''}) wants your agent.`);
    console.log('');
    for (const tool of grant.tools) {
      console.log(`    ${gated.has(tool.name) ? '!' : '✓'} ${tool.description}`);
    }
    console.log('');
    console.log(`    grant expires ${new Date(grant.expiresAt).toLocaleTimeString()}`);
    console.log('');
    return ask('  Allow?');
  },

  onLocalApproval: async (summary, call) => {
    console.log('');
    console.log(`  ${summary}`);
    if (call) console.log(`    ${call.name}(${JSON.stringify(call.arguments).slice(0, 200)})`);
    return ask('  Approve?');
  },

  onBound: (cert) => {
    saveIdentity(identityPath, { ...identity, cert });
    console.log(`[agent] paired with user ${cert.user.slice(0, 16)}… — this agent is now selectable in the picker`);
  },
});

const { bound } = await daemon.start();
console.log(`[agent] ${identity.name} (${identity.publicKey.slice(0, 16)}…) connected to ${relayUrl}`);
if (bound) console.log('[agent] already paired — waiting for sessions');

console.log('');
console.log('  Paste a connect code from any site using the AgentPort widget:');
console.log('');

rl.on('line', (line) => {
  const code = line.trim().toUpperCase();
  if (/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) daemon.claimConnect(code);
  else if (code) console.log(`  "${code}" is not a connect code (expected AAAA-BBBB)`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void daemon.stop().then(() => process.exit(0));
  });
}
