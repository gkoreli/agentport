import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomId } from '@agentport/protocol';

/**
 * The control file: how a CLI process asks a running daemon for something it
 * can only do live, and how the daemon answers.
 *
 * Deliberately the SAME file and the same 200 ms poll the pairing flow
 * already uses, rather than a second seam. It also carries no authority of
 * its own: everything reachable through it is either something the caller
 * could do by editing files directly, or something that only narrows what
 * the agent will accept. There is no un-revoke and no re-pair here — see
 * ADR-022 R12 for why rebinding must be a deliberate unpair first.
 */
export type PairingControlState =
  | { status: 'request'; id: string; requestedAt: number }
  | { status: 'pending'; code: string; url: string; expiresAt: number }
  | { status: 'bound'; user: string; pairedAt: number }
  | { status: 'unpair'; id: string; requestedAt: number }
  | { status: 'unpaired'; id: string; at: number }
  | { status: 'error'; message: string; at: number };

export function pairingControlPath(identityPath: string): string {
  return process.env.AGENTPORT_PAIRING_FILE ?? join(dirname(identityPath), 'pairing.json');
}

/** Atomic and owner-only because the file coordinates a security-sensitive UI. */
export function writePairingControl(path: string, state: PairingControlState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomId('tmp_')}`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporary, path);
}

export function readPairingControl(path: string): PairingControlState | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<PairingControlState>;
    if (value.status === 'request' && typeof value.id === 'string' && typeof value.requestedAt === 'number') {
      return value as Extract<PairingControlState, { status: 'request' }>;
    }
    if (value.status === 'pending' && typeof value.code === 'string' && typeof value.url === 'string' && typeof value.expiresAt === 'number') {
      return value as Extract<PairingControlState, { status: 'pending' }>;
    }
    if (value.status === 'bound' && typeof value.user === 'string' && typeof value.pairedAt === 'number') {
      return value as Extract<PairingControlState, { status: 'bound' }>;
    }
    if (value.status === 'unpair' && typeof value.id === 'string' && typeof value.requestedAt === 'number') {
      return { status: 'unpair', id: value.id, requestedAt: value.requestedAt };
    }
    if (value.status === 'unpaired' && typeof value.id === 'string' && typeof value.at === 'number') {
      return { status: 'unpaired', id: value.id, at: value.at };
    }
    if (value.status === 'error' && typeof value.message === 'string' && typeof value.at === 'number') {
      return value as Extract<PairingControlState, { status: 'error' }>;
    }
    throw new Error('malformed pairing control state');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // A parse failure quotes the offending bytes in V8's message, and those
    // bytes came from a file anything running as this user can write. They
    // must not reach a log, a terminal, or the control file itself
    // (ADR-019 §1: attacker bytes never become output).
    throw new Error('malformed pairing control state');
  }
}
