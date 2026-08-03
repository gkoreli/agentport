/**
 * PLAINTEXT STORAGE V1.
 *
 * The hosted-wallet prototype keeps the root secret in origin-scoped
 * localStorage. The production upgrade is passkey-wrapped key material,
 * unlocked for the browser session; changing that wrapper must not change the
 * delegation or cert formats.
 */

import {
  generateKeyPair,
  publicKeyOf,
  verifyCert,
  type AgentCert,
  type KeyPair,
} from '@agentport/protocol';

const IDENTITY_KEY = 'agentport.wallet.identity.v1';
const CERTS_KEY = 'agentport.wallet.certs.v1';

interface StoredIdentityV1 {
  version: 1;
  secretKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readIdentity(raw: string | null): KeyPair | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed['version'] !== 1 || typeof parsed['secretKey'] !== 'string') return null;
    const publicKey = publicKeyOf(parsed['secretKey']);
    return { secretKey: parsed['secretKey'], publicKey };
  } catch {
    return null;
  }
}

/** Silently creates the wallet key on first visit; storage failure is fatal. */
export function ensureIdentity(storage: Storage = localStorage): KeyPair {
  const raw = storage.getItem(IDENTITY_KEY);
  const existing = readIdentity(raw);
  if (existing) return existing;
  if (raw !== null) throw new Error('stored wallet identity is unreadable; refusing to overwrite it');

  const created = generateKeyPair();
  const value: StoredIdentityV1 = { version: 1, secretKey: created.secretKey };
  storage.setItem(IDENTITY_KEY, JSON.stringify(value));
  return created;
}

function isAgentCert(value: unknown): value is AgentCert {
  if (!isRecord(value)) return false;
  return (
    typeof value['user'] === 'string' &&
    typeof value['agent'] === 'string' &&
    typeof value['name'] === 'string' &&
    typeof value['runtime'] === 'string' &&
    (value['location'] === undefined || typeof value['location'] === 'string') &&
    typeof value['issuedAt'] === 'number' &&
    typeof value['sig'] === 'string'
  );
}

export function loadCerts(user: string, storage: Storage = localStorage): AgentCert[] {
  try {
    const raw = storage.getItem(CERTS_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('cert store is not a list');
    const valid = parsed.filter((cert): cert is AgentCert => isAgentCert(cert) && cert.user === user && verifyCert(cert));
    if (valid.length !== parsed.length) {
      console.warn(`[agentport-wallet] ignored ${parsed.length - valid.length} invalid certificate(s)`);
    }
    return valid;
  } catch (err) {
    console.warn('[agentport-wallet] ignored an unreadable cert store', err);
    return [];
  }
}

export function saveCert(cert: AgentCert, storage: Storage = localStorage): AgentCert[] {
  if (!verifyCert(cert)) throw new Error('refusing to store an invalid agent certificate');
  const certs = loadCerts(cert.user, storage).filter((candidate) => candidate.agent !== cert.agent);
  certs.push(cert);
  storage.setItem(CERTS_KEY, JSON.stringify(certs));
  return certs;
}
