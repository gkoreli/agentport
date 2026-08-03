import { spawnSync } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pairingControlPath, readPairingControl } from '@agentport/daemon/pairing-control';

const identityPath = process.env.AGENTPORT_IDENTITY ?? join(homedir(), '.agentport', 'agent.json');
const statePath = pairingControlPath(identityPath);

if (process.platform !== 'linux') {
  throw new Error('agentport pair currently requires an installed Linux systemd service');
}

try {
  unlinkSync(statePath);
} catch (err) {
  if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
}

const signalled = spawnSync('systemctl', ['kill', '--signal=SIGUSR1', 'agentport.service'], { encoding: 'utf8' });
if (signalled.status !== 0) {
  const detail = (signalled.stderr || signalled.stdout).trim();
  throw new Error(`could not ask the AgentPort service to pair${detail ? `: ${detail}` : ''}`);
}

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
