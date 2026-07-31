/**
 * Isomorphic crypto helpers (Node 20+ and browsers).
 *
 * v0 uses raw Ed25519 keypairs so the whole flow is runnable without external
 * infrastructure. The identity layer is deliberately isolated here: swapping
 * the user key for a NIP-46 bunker or a passkey-derived key should not touch
 * anything outside this file and `identity.ts`.
 */

import { ed25519 } from '@noble/curves/ed25519';
import type { AgentCert, Hex } from './messages.js';

export interface KeyPair {
  publicKey: Hex;
  secretKey: Hex;
}

const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): Hex {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

export function fromHex(hex: Hex): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('invalid hex string');
    out[i] = byte;
  }
  return out;
}

/** Structural, so this file compiles under DOM, Node and Workers lib sets alike. */
const webcrypto = globalThis as unknown as {
  crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T };
};

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  webcrypto.crypto.getRandomValues(out);
  return out;
}

export function generateKeyPair(): KeyPair {
  const secretKey = ed25519.utils.randomPrivateKey();
  return {
    secretKey: toHex(secretKey),
    publicKey: toHex(ed25519.getPublicKey(secretKey)),
  };
}

export function publicKeyOf(secretKey: Hex): Hex {
  return toHex(ed25519.getPublicKey(fromHex(secretKey)));
}

const encoder = new TextEncoder();

export function sign(secretKey: Hex, message: string): Hex {
  return toHex(ed25519.sign(encoder.encode(message), fromHex(secretKey)));
}

export function verify(publicKey: Hex, message: string, signature: Hex): boolean {
  try {
    return ed25519.verify(fromHex(signature), encoder.encode(message), fromHex(publicKey));
  } catch {
    return false;
  }
}

/** Deterministic JSON so signatures are reproducible across implementations. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function certBody(cert: Omit<AgentCert, 'sig'>): string {
  return `agentport-cert:${canonicalJson({
    user: cert.user,
    agent: cert.agent,
    name: cert.name,
    runtime: cert.runtime,
    location: cert.location,
    issuedAt: cert.issuedAt,
  })}`;
}

export function signCert(userSecretKey: Hex, body: Omit<AgentCert, 'sig'>): AgentCert {
  return { ...body, sig: sign(userSecretKey, certBody(body)) };
}

export function verifyCert(cert: AgentCert): boolean {
  const { sig, ...body } = cert;
  return verify(cert.user, certBody(body), sig);
}

export function authChallengeMessage(nonce: string): string {
  return `agentport-auth:${nonce}`;
}

export function randomId(prefix = ''): string {
  return prefix + toHex(randomBytes(8));
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1

/** Short human-transcribable pairing code, e.g. "R7KP-92MX". */
export function pairingCode(): string {
  const bytes = randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) {
    if (i === 4) out += '-';
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}
