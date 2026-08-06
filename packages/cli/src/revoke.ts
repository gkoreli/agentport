/**
 * `agentport status`, `revoke`, and `unpair` — the browser-unavailable tier
 * (ADR-019 Gate B §5, ADR-022 R10).
 *
 * The wallet is the ordinary way to do this: the user is in a browser, not a
 * terminal, and the wire path exists for exactly that. This tier earns its
 * place for the case Gate B names — the browser is gone, or the wallet that
 * would have spoken for you is. It is a second *caller*, never a second
 * implementation: `revoke` writes the same tombstone file the daemon reads,
 * and `unpair` asks the running daemon to perform its own operation.
 *
 * Honest limitation, and it is not one this file can fix: everything here is
 * reachable by anything running as the same user — including the agent
 * runtime, whose own filesystem tools run beside these files. Until ADR-019
 * Gate C gives the runtime its own containment, a local seam cannot hold
 * authority the runtime lacks. Nothing here grants: every verb only narrows
 * what the agent will accept, and there is deliberately no un-revoke and no
 * re-pair (ADR-022 R2, R12).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadIdentity } from '@agentport/daemon';
import {
  pairingControlPath,
  readPairingControl,
  writePairingControl,
} from '@agentport/daemon/pairing-control';
import { fileRevocations, revocationsPath } from '@agentport/daemon/revocations';
import { randomId } from '@agentport/protocol';

const identityPath = (): string =>
  process.env['AGENTPORT_IDENTITY'] ?? join(homedir(), '.agentport', 'agent.json');

/**
 * Six bytes of the cert body's signature, grouped. Gate B §5 asks for a
 * fingerprint the user can compare against what their wallet shows; the
 * signature is already the credential's own unique handle, so nothing new
 * has to be minted to name it.
 */
function fingerprint(sig: string): string {
  return (sig.slice(0, 12).match(/.{1,4}/g) ?? []).join('-');
}

function loadOrExplain(): ReturnType<typeof loadIdentity> | undefined {
  try {
    return loadIdentity(identityPath(), { name: '', runtime: '' });
  } catch (err) {
    console.error(`  could not read ${identityPath()}: ${err instanceof Error ? err.message : 'unreadable'}`);
    return undefined;
  }
}

export function status(): number {
  const identity = loadOrExplain();
  if (!identity) return 1;

  console.log('');
  console.log(`  ${identity.name || '(unnamed agent)'} — ${identity.runtime || 'no runtime'}`);
  if (identity.location) console.log(`  ${identity.location}`);
  console.log(`  agent key   ${identity.publicKey}`);

  if (identity.cert) {
    console.log(`  owner       ${identity.cert.user}`);
    console.log(`  fingerprint ${fingerprint(identity.cert.sig)}`);
    console.log(`  paired      ${new Date(identity.cert.issuedAt).toLocaleString()}`);
  } else {
    console.log('  owner       (none — this agent accepts no sessions until it is paired)');
  }

  const store = fileRevocations(revocationsPath(identityPath()), (err) => {
    console.error(`  revocations unreadable: ${err.message}`);
  });
  const revocations = store.list();
  console.log('');
  if (revocations.length === 0) {
    console.log('  no origins revoked');
  } else {
    console.log('  revoked origins (authority issued before each time is refused):');
    for (const entry of revocations) {
      console.log(`    ${entry.origin} — ${new Date(entry.at).toLocaleString()}`);
    }
  }

  const pairing = readPairingControl(pairingControlPath(identityPath()));
  if (pairing?.status === 'pending') console.log(`\n  pairing code ${pairing.code} is waiting to be claimed`);

  // Live attachments are in the running process's memory and nowhere else,
  // so this cannot show them. Saying so is better than implying there are
  // none — the wallet's own view is the one that lists them.
  console.log('');
  console.log('  live attachments are visible in your wallet, not here');
  console.log('');
  return 0;
}

export function revoke(origin: string): number {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    console.error(`  "${origin}" is not an origin (expected e.g. https://example.com)`);
    return 1;
  }
  if (parsed.origin !== origin) {
    // Exact match is what the daemon enforces, so accepting a path or a
    // trailing slash here would silently revoke nothing.
    console.error(`  use the exact origin: ${parsed.origin}`);
    return 1;
  }

  let failed = false;
  const store = fileRevocations(revocationsPath(identityPath()), (err) => {
    console.error(`  could not read existing revocations: ${err.message}`);
    failed = true;
  });
  if (failed) return 1;

  store.add({ origin: parsed.origin, at: Date.now() });
  console.log('');
  console.log(`  ${parsed.origin} can no longer use this agent.`);
  console.log('  Every authority it already holds is dead; a running daemon ends its');
  console.log('  attachments within a second. Approving it again still works — this');
  console.log('  is not a block list.');
  console.log('');
  return 0;
}

/**
 * Unpair MUST reach the running process. A daemon holds its cert in memory
 * and has already presented it on its authenticated socket, so editing the
 * identity file underneath it changes nothing until a restart — an unpair
 * that silently did not happen is worse than one that refuses.
 */
export async function unpair(): Promise<number> {
  const identity = loadOrExplain();
  if (!identity) return 1;
  if (!identity.cert) {
    console.log('\n  this agent has no owner; nothing to unpair\n');
    return 0;
  }

  const path = pairingControlPath(identityPath());
  const id = randomId('unpair_');
  writePairingControl(path, { status: 'unpair', id, requestedAt: Date.now() });

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = readPairingControl(path);
    if (state?.status === 'unpaired' && state.id === id) {
      console.log('');
      console.log('  Unpaired. This agent now accepts nothing until you pair it again.');
      console.log('  Run `agentport` to pair it.');
      console.log('');
      return 0;
    }
    if (state?.status === 'error') {
      console.error(`\n  the daemon refused: ${state.message}\n`);
      return 1;
    }
  }

  console.error('');
  console.error('  No daemon answered. Start it and run this again — unpairing a daemon');
  console.error('  that is still running has to be done by the daemon itself, or it will');
  console.error('  keep serving the sessions you meant to end.');
  console.error('');
  return 1;
}
