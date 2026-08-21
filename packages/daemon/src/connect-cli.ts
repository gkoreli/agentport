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
import { registerAcpRuntimes, resolveAcpSpawn } from './acp-preflight.js';
import { createTerminalAsk } from './terminal-ask.js';
import { loadIdentity, saveIdentity } from './identity.js';
import { RUNTIMES } from './runtime.js';
import { McpBridge } from './mcp-bridge.js';
import { createLogger, isGated } from '@agentport/protocol';

const log = createLogger('daemon.connect-cli');

process.on('uncaughtException', (err) => {
  log.error('uncaught exception; terminating connect command', { err });
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  log.error('unhandled rejection; terminating connect command', { err });
  process.exit(1);
});

const code = (process.argv[2] ?? '').trim().toUpperCase();
if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
  log.error('invalid connect code; usage: agentport connect <CODE>', { data: { example: 'UBFS-MV6M' } });
  process.exit(1);
}

const dim = (text: string) => `\u001b[2m${text}\u001b[0m`;
const bold = (text: string) => `\u001b[1m${text}\u001b[0m`;

const relayUrl = process.env.AGENTPORT_RELAY ?? 'wss://agentport.gogakoreli.workers.dev/relay';
const identityPath = process.env.AGENTPORT_IDENTITY ?? join(homedir(), '.agentport', 'agent.json');
const runtimeName = process.env.AGENTPORT_RUNTIME ?? 'claude-code';

const acp = resolveAcpSpawn(process.env);
if (typeof acp === 'string') {
  log.error(acp);
  process.exit(1);
}

const bridge = new McpBridge();
// No runtime preflight here, unlike `packages/daemon/src/cli.ts`: a connect
// code is already on a screen and expires in minutes, and the probe's own
// bound is up to a minute of it. `agentport doctor` is the command for
// "before a site is waiting on me".
registerAcpRuntimes(acp, bridge);

const createRuntime = RUNTIMES[runtimeName];
if (!createRuntime) {
  log.error('unknown runtime', { data: { runtimeName, known: Object.keys(RUNTIMES) } });
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


/** Did the relay find the code at all? Separate from whether you said yes. */
let offerReceived = false;

const daemon = new AgentDaemon({
  relayUrl,
  identity,
  createRuntime,

  onConnectOffer: async ({ surface, grant, verify }) => {
    offerReceived = true;
    console.log('');
    console.log(`  ${bold(surface.name)} ${dim(surface.origin)}`);
    console.log(`  wants to use ${bold(identity.name)} (${identity.runtime}).`);
    console.log('');
    console.log(dim('  It will be able to:'));
    for (const tool of grant.tools) {
      console.log(`    ${isGated(tool, grant) ? '[33m![0m' : '[32m✓[0m'} ${tool.description}`);
    }
    if (grant.tools.some((tool) => isGated(tool, grant))) {
      console.log(dim(`\n  ! = asks you again, every single time`));
    }
    if (verify) {
      console.log('');
      console.log(`  Verify: ${bold(verify)}`);
      console.log(dim('  The website shows the same six words. A mismatch means someone'));
      console.log(dim('  is sitting between you — decline.'));
    }
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

  // Supplying this is what grants the connect tier elicitation at all
  // (ADR-024 R12) — without it the daemon refuses rather than routing the
  // question to the requesting page.
  onLocalAsk: createTerminalAsk(rl, () => stdinClosed, { bold, dim }),

  onLocalApproval: async (domain, summary, call) => {
    console.log('');
    // Which authority, in words, before anything the agent wrote. The summary
    // is agent-authored and can be made to read like a site's own tool.
    console.log(
      domain === 'site_tool'
        ? '  The website is asking your agent to use a tool it lent:'
        : '  Your agent wants to use ITS OWN tool on this machine:',
    );
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
    void daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('graceful daemon shutdown failed', { err, data: { signal } });
        process.exit(1);
      },
    );
  });
}
