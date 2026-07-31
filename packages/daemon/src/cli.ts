import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentDaemon } from './daemon.js';
import { loadIdentity, saveIdentity } from './identity.js';
import { RUNTIMES } from './runtime.js';

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
  onBound: (cert) => {
    saveIdentity(identityPath, { ...identity, cert });
    console.log(`[agent] paired with user ${cert.user.slice(0, 16)}… — this agent is now selectable in the picker`);
  },
});

const { bound } = await daemon.start();
console.log(`[agent] ${identity.name} (${identity.publicKey.slice(0, 16)}…) connected to ${relayUrl}`);
if (bound) console.log('[agent] already paired — waiting for sessions');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void daemon.stop().then(() => process.exit(0));
  });
}
