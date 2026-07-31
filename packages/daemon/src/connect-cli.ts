/**
 * `agentport connect <CODE>` — the one command a website can tell you to run.
 *
 * Starts your agent if it isn't running, claims the code the site is showing,
 * prints exactly what is being asked for, and waits for you to say yes. The
 * whole point is that a stranger's website can hand you a single copyable line
 * and you never have to understand any of the above.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AgentDaemon } from './daemon.js';
import { loadIdentity, saveIdentity } from './identity.js';
import { RUNTIMES, registerRuntime } from './runtime.js';
import { McpBridge } from './mcp-bridge.js';
import { AcpRuntime } from './runtimes/acp.js';

const code = (process.argv[2] ?? '').trim().toUpperCase();
if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
  console.error('usage: agentport connect <CODE>   (e.g. agentport connect UBFS-MV6M)');
  process.exit(1);
}

const relayUrl = process.env.AGENTPORT_RELAY ?? 'wss://agentport.gogakoreli.workers.dev/relay';
const identityPath = process.env.AGENTPORT_IDENTITY ?? join(homedir(), '.agentport', 'agent.json');
const runtimeName = process.env.AGENTPORT_RUNTIME ?? 'claude-code';

const bridge = new McpBridge();
for (const name of ['claude-code', 'acp']) {
  registerRuntime(
    name,
    () =>
      new AcpRuntime({
        command: process.env.AGENTPORT_ACP_COMMAND ?? 'npx',
        args: (process.env.AGENTPORT_ACP_ARGS ?? '-y @agentclientprotocol/claude-agent-acp')
          .split(' ')
          .filter(Boolean),
        cwd: process.env.AGENTPORT_AGENT_CWD ?? process.cwd(),
        bridge,
        log: () => {},
      }),
  );
}

const createRuntime = RUNTIMES[runtimeName];
if (!createRuntime) {
  console.error(`unknown runtime "${runtimeName}"; known: ${Object.keys(RUNTIMES).join(', ')}`);
  process.exit(1);
}

const identity = loadIdentity(identityPath, {
  name: process.env.AGENTPORT_NAME ?? 'My Agent',
  runtime: runtimeName,
  location: process.env.AGENTPORT_LOCATION ?? 'this machine',
});

const rl = createInterface({ input: process.stdin, output: process.stdout });
let stdinClosed = false;
rl.on('close', () => (stdinClosed = true));

const ask = (question: string) =>
  new Promise<boolean>((resolve) => {
    // A closed or non-interactive stdin must read as "no", not as a crash:
    // this prompt is a security boundary, so failure has to fail shut.
    if (stdinClosed) return resolve(false);
    rl.once('close', () => resolve(false));
    try {
      rl.question(`${question} [y/N] `, (answer) => resolve(/^y(es)?$/i.test(answer.trim())));
    } catch {
      resolve(false);
    }
  });

const dim = (text: string) => `[2m${text}[0m`;
const bold = (text: string) => `[1m${text}[0m`;

/** Did the relay find the code at all? Separate from whether you said yes. */
let offerReceived = false;

const daemon = new AgentDaemon({
  relayUrl,
  identity,
  createRuntime,
  log: () => {},

  onConnectOffer: async ({ surface, grant }) => {
    offerReceived = true;
    const gated = new Set([
      ...grant.alwaysAsk,
      ...grant.tools.filter((tool) => tool.requiresApproval).map((tool) => tool.name),
    ]);
    console.log('');
    console.log(`  ${bold(surface.name)} ${dim(surface.origin)}`);
    console.log(`  wants to use ${bold(identity.name)} (${identity.runtime}).`);
    console.log('');
    console.log(dim('  It will be able to:'));
    for (const tool of grant.tools) {
      console.log(`    ${gated.has(tool.name) ? '[33m![0m' : '[32m✓[0m'} ${tool.description}`);
    }
    if (gated.size) console.log(dim(`\n  ! = asks you again, every single time`));
    console.log(dim(`\n  Expires ${new Date(grant.expiresAt).toLocaleTimeString()}. Nothing else about your agent is shared.`));
    console.log('');
    const allowed = await ask('  Allow?');
    console.log(
      allowed
        ? dim('\n  Connected. Go back to the tab — leave this running.\n')
        : dim('\n  Declined. Nothing was shared.\n'),
    );
    if (!allowed) setTimeout(() => process.exit(0), 100);
    return allowed;
  },

  onLocalApproval: async (summary, call) => {
    console.log('');
    console.log(`  ${bold(summary)}`);
    if (call) console.log(dim(`    ${JSON.stringify(call.arguments).slice(0, 220)}`));
    return ask('  Approve?');
  },

  // Pairing only matters for the wallet flow; a connect code needs no cert.
  onPairingCode: () => {},
  onBound: (cert) => saveIdentity(identityPath, { ...identity, cert }),
});

console.log(dim(`\n  connecting to ${relayUrl}…`));
await daemon.start();
daemon.claimConnect(code);

// Only guards "the relay never had this code" — never the time you spend
// reading the consent screen.
setTimeout(() => {
  if (!offerReceived) {
    console.log(dim(`\n  No request found for ${code}.`));
    console.log(dim('  Codes expire after a few minutes — reload the page and try the new one.\n'));
    process.exit(1);
  }
}, 10_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void daemon.stop().then(() => process.exit(0));
  });
}
