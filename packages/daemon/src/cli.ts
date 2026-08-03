import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AgentDaemon } from './daemon.js';
import { loadIdentity, saveIdentity } from './identity.js';
import { RUNTIMES, registerRuntime } from './runtime.js';
import { McpBridge } from './mcp-bridge.js';
import { AcpRuntime } from './runtimes/acp.js';
import { createLogger } from '@agentport/protocol';

const log = createLogger('daemon.cli');

process.on('uncaughtException', (err) => {
  log.error('uncaught exception; terminating daemon', { err });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection; terminating daemon', { err });
  process.exit(1);
});

// One bridge per daemon; each session gets its own token-scoped endpoint on it.
const bridge = new McpBridge();

registerRuntime(
  'claude-code',
  () =>
    new AcpRuntime({
      command: process.env.AGENTPORT_ACP_COMMAND ?? 'npx',
      args: (process.env.AGENTPORT_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp').split(' '),
      cwd: process.env.AGENTPORT_AGENT_CWD ?? process.cwd(),
      bridge,
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
    }),
);

const relayUrl = process.env.AGENTPORT_RELAY ?? 'ws://127.0.0.1:8787';
const walletUrl = process.env.AGENTPORT_WALLET ?? 'http://127.0.0.1:8788/pair';
const identityPath = process.env.AGENTPORT_IDENTITY ?? join(homedir(), '.agentport', 'agent.json');
const runtimeName = process.env.AGENTPORT_RUNTIME ?? 'demo-writer';

const createRuntime = RUNTIMES[runtimeName];
if (!createRuntime) {
  log.error('unknown runtime', { data: { runtimeName, known: Object.keys(RUNTIMES) } });
  process.exit(1);
}

const identity = loadIdentity(identityPath, {
  name: process.env.AGENTPORT_NAME ?? "Goga's Writing Agent",
  runtime: runtimeName,
  location: process.env.AGENTPORT_LOCATION ?? 'Personal VPS',
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
let stdinClosed = false;
rl.on('close', () => (stdinClosed = true));

function ask(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    // Fail shut: a closed or non-interactive stdin is a decline, not a crash.
    if (stdinClosed) return resolve(false);
    rl.once('close', () => resolve(false));
    try {
      rl.question(`${question} [y/N] `, (answer) => resolve(/^y(es)?$/i.test(answer.trim())));
    } catch {
      resolve(false);
    }
  });
}

const daemon = new AgentDaemon({
  relayUrl,
  identity,
  createRuntime,
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
  onConnectOffer: async ({ surface, grant, verify }) => {
    const gated = new Set([...grant.alwaysAsk, ...grant.tools.filter((t) => t.requiresApproval).map((t) => t.name)]);
    console.log('');
    console.log(`  ${surface.name} (${surface.origin}${surface.route ?? ''}) wants your agent.`);
    console.log('');
    for (const tool of grant.tools) {
      console.log(`    ${gated.has(tool.name) ? '!' : '✓'} ${tool.description}`);
    }
    console.log('');
    console.log(`    grant expires ${new Date(grant.expiresAt).toLocaleTimeString()}`);
    if (verify) console.log(`\n    verify: ${verify} (the site shows the same words)`);
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
    log.info('agent paired and selectable in the picker', { data: { user: cert.user.slice(0, 16) } });
  },
});

const { bound } = await daemon.start();
log.info('agent connected to relay', {
  data: { name: identity.name, agent: identity.publicKey.slice(0, 16), relayUrl },
});
if (bound) log.info('agent already paired; waiting for sessions');

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
    void daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('graceful daemon shutdown failed', { err, data: { signal } });
        process.exit(1);
      },
    );
  });
}
