import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { generateKeyPair, publicKeyOf, type AgentCert, type Hex } from '@agentport/protocol';

export interface AgentIdentity {
  secretKey: Hex;
  publicKey: Hex;
  name: string;
  runtime: string;
  location?: string;
  cert?: AgentCert;
}

/**
 * Load or create the agent's device identity. The secret key never leaves this
 * machine — the relay only ever sees signatures and the cert the user signed.
 */
export function loadIdentity(path: string, defaults: { name: string; runtime: string; location?: string }): AgentIdentity {
  try {
    const stored = JSON.parse(readFileSync(path, 'utf8')) as AgentIdentity;
    // fromHex is lowercase-only (wire canonicalization); a hand-edited or
    // third-party identity file may spell the secret uppercase. Normalize at
    // this edge instead of widening the decoder's accepted domain.
    const secretKey = stored.secretKey.toLowerCase();
    return { ...stored, secretKey, publicKey: publicKeyOf(secretKey) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const keys = generateKeyPair();
  const identity: AgentIdentity = { ...keys, ...defaults };
  saveIdentity(path, identity);
  return identity;
}

export function saveIdentity(path: string, identity: AgentIdentity): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
}
