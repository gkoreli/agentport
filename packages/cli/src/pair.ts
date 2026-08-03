import { homedir } from 'node:os';
import { join } from 'node:path';
import { pairingControlPath, readPairingControl, writePairingControl } from '@agentport/daemon/pairing-control';
import { randomId } from '@agentport/protocol';

const identityPath = process.env.AGENTPORT_IDENTITY ?? join(homedir(), '.agentport', 'agent.json');
const statePath = pairingControlPath(identityPath);

writePairingControl(statePath, { status: 'request', id: randomId('pair_'), requestedAt: Date.now() });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now();
let pending: Extract<NonNullable<ReturnType<typeof readPairingControl>>, { status: 'pending' }> | undefined;

while (Date.now() - startedAt < 15_000) {
  const state = readPairingControl(statePath);
  if (state?.status === 'error') throw new Error(state.message);
  if (state?.status === 'pending') {
    pending = state;
    break;
  }
  await sleep(100);
}

if (!pending) throw new Error('the AgentPort service did not produce a pairing offer');

console.log('\nPair this agent in Chrome:\n');
console.log(`  ${pending.url}\n`);
console.log(`Code: ${pending.code}`);
console.log('Waiting for approval in the AgentPort extension…\n');

let paired = false;
while (Date.now() <= pending.expiresAt) {
  const state = readPairingControl(statePath);
  if (state?.status === 'bound') {
    console.log('Paired. The VPS agent is now available in Chrome.');
    paired = true;
    break;
  }
  if (state?.status === 'error') throw new Error(state.message);
  await sleep(250);
}

if (!paired) throw new Error('pairing offer expired before it was approved');
