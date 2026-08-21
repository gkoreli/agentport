import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { AgentDaemon } from './daemon.js';
import {
  ACP_PROBE_DEADLINE_MS,
  acpCommandLine,
  describeAcpProbe,
  isAcpRuntime,
  probeAcpRuntime,
  registerAcpRuntimes,
  resolveAcpSpawn,
} from './acp-preflight.js';
import { createTerminalAsk } from './terminal-ask.js';
import { loadIdentity, saveIdentity } from './identity.js';
import { pairingControlPath, readPairingControl, writePairingControl } from './pairing-control.js';
import { fileRevocations, revocationsPath } from './revocations.js';
import { RUNTIMES } from './runtime.js';
import { McpBridge } from './mcp-bridge.js';
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
const acp = resolveAcpSpawn(process.env);
if (typeof acp === 'string') {
  log.error(acp);
  process.exit(1);
}

const bridge = new McpBridge();

// `claude-code` and `acp` both mean "drive the resolved command pair over ACP"
// — the second exists so any agent at all can be named:
// AGENTPORT_ACP_COMMAND=goose AGENTPORT_ACP_ARGS=acp
registerAcpRuntimes(acp, bridge);

const relayUrl = process.env.AGENTPORT_RELAY ?? 'ws://127.0.0.1:8787';
const walletUrl = process.env.AGENTPORT_WALLET ?? 'http://127.0.0.1:8788/pair';
const identityPath = process.env.AGENTPORT_IDENTITY ?? join(homedir(), '.agentport', 'agent.json');
const pairingPath = pairingControlPath(identityPath);
const runtimeName = process.env.AGENTPORT_RUNTIME ?? 'demo-writer';

const createRuntime = RUNTIMES[runtimeName];
if (!createRuntime) {
  log.error('unknown runtime', { data: { runtimeName, known: Object.keys(RUNTIMES) } });
  process.exit(1);
}

// Preflight, before the relay is dialled and before a pairing code exists.
// An ACP agent that cannot be started is a failure the terminal running this
// can fix; the same failure discovered after pairing is a session error in
// someone's browser, on the far side of a relay. Demo runtimes spawn nothing,
// so `npm run daemon` never pays for this. `agentport doctor` runs the same
// probe on demand — one implementation, one remediation.
if (isAcpRuntime(runtimeName)) {
  log.info('checking the agent runtime before pairing', {
    data: {
      command: acpCommandLine(acp),
      // Honest about the cost: this delays the pairing code, and a machine
      // that has never fetched the agent waits for npx to download it first.
      // This is where the wait stops either way.
      atMostSeconds: Math.round(ACP_PROBE_DEADLINE_MS / 1000),
    },
  });
  const probe = await probeAcpRuntime(acp);
  if (!probe.ok) {
    for (const line of describeAcpProbe(probe, runtimeName)) console.error(line);
    log.error('the agent runtime is not usable; not pairing', {
      data: { runtimeName, kind: probe.kind, command: acpCommandLine(acp) },
    });
    process.exit(1);
  }
  log.info('agent runtime ready', {
    data: {
      runtimeName,
      command: acpCommandLine(acp),
      acpVersion: probe.protocolVersion,
      loadSession: probe.loadSession,
      // Not proof of a login — see acp-preflight.ts's header. `agentport
      // doctor` prints the auth methods this counted.
      authMethods: probe.authMethods.length,
    },
  });
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
  onPairingCode: (code, expiresAt) => {
    const url = `${walletUrl}#code=${code}`;
    writePairingControl(pairingPath, { status: 'pending', code, url, expiresAt });
    console.log('');
    console.log('  Your agent is ready to pair:');
    console.log('');
    console.log(`    ${url}`);
    console.log('');
    console.log(`  Code: ${code}`);
    console.log('');
    console.log('  With the AgentPort extension, the link pairs in one tap. Without it,');
    console.log('  the page links a hosted wallet where the same code works in any browser.');
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

  // Supplying this is what grants the connect tier elicitation at all
  // (ADR-024 R12) — without it the daemon refuses rather than routing the
  // question to the requesting page.
  onLocalAsk: createTerminalAsk(rl, () => stdinClosed),

  onLocalApproval: async (domain, summary, call) => {
    console.log('');
    // Which authority, in words, before anything the agent wrote. The summary
    // is agent-authored and can be made to read like a site's own tool.
    console.log(
      domain === 'site_tool'
        ? '  The website is asking your agent to use a tool it lent:'
        : "  Your agent wants to use ITS OWN tool on this machine:",
    );
    console.log(`  ${summary}`);
    if (call) console.log(`    ${call.name}(${JSON.stringify(call.arguments).slice(0, 200)})`);
    return ask('  Approve?');
  },

  onBound: (cert) => {
    saveIdentity(identityPath, { ...identity, cert });
    writePairingControl(pairingPath, { status: 'bound', user: cert.user, pairedAt: Date.now() });
    log.info('agent paired and selectable in the picker', { data: { user: cert.user.slice(0, 16) } });
  },

  onUnbound: () => {
    const { cert: _dropped, ...unowned } = identity;
    saveIdentity(identityPath, unowned);
  },

  revocations: fileRevocations(revocationsPath(identityPath), (err) => {
    log.error('could not read revocations; assuming none', { err });
  }),
});

const { bound } = await daemon.start();
log.info('agent connected to relay', {
  data: { name: identity.name, agent: identity.publicKey.slice(0, 16), relayUrl },
});
if (bound) {
  log.info('agent already paired; waiting for sessions');
  if (process.env.AGENTPORT_PAIR_ON_START === '1') daemon.beginPairing();
}

let handledControlRequest: string | undefined;
const pairingControlTimer = setInterval(() => {
  try {
    // `agentport revoke` writes only the tombstone file; nothing asks this
    // process for anything. Open and resume are already refused because the
    // store re-reads that file — this ends attachments that are ALREADY live
    // (ADR-022 R11). Idempotent, so polling it costs nothing.
    void daemon.enforceRevocations().catch((err: unknown) => {
      log.error('could not close revoked attachments', { err });
    });

    const state = readPairingControl(pairingPath);
    if (state?.status === 'unpair' && state.id !== handledControlRequest) {
      handledControlRequest = state.id;
      const id = state.id;
      void daemon
        .unpair()
        .then(() => {
          writePairingControl(pairingPath, { status: 'unpaired', id, at: Date.now() });
          log.info('agent unpaired; it now accepts nothing until paired again');
        })
        .catch((err: unknown) => {
          log.error('could not unpair', { err });
        });
      return;
    }
    if (state?.status !== 'request' || state.id === handledControlRequest) return;
    handledControlRequest = state.id;
    daemon.beginPairing();
  } catch (err) {
    // The message is ours (readPairingControl never quotes file bytes), so
    // it is safe to write back and log.
    const message = err instanceof Error ? err.message : 'control file unreadable';
    writePairingControl(pairingPath, { status: 'error', message, at: Date.now() });
    log.error('could not act on the control file', { err });
  }
}, 200);

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
    clearInterval(pairingControlTimer);
    void daemon.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('graceful daemon shutdown failed', { err, data: { signal } });
        process.exit(1);
      },
    );
  });
}
