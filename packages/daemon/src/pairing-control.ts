import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomId } from '@agentport/protocol';

export type PairingControlState =
  | { status: 'request'; id: string; requestedAt: number }
  | { status: 'pending'; code: string; url: string; expiresAt: number }
  | { status: 'bound'; user: string; pairedAt: number }
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
    if (value.status === 'error' && typeof value.message === 'string' && typeof value.at === 'number') {
      return value as Extract<PairingControlState, { status: 'error' }>;
    }
    throw new Error('malformed pairing control state');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}
