/**
 * The root key at rest: wrapped, or legacy-plaintext and said so.
 *
 * THREAT MODEL — what wrapping protects, exactly. The wrapped form defends
 * the seed AT REST: a stolen disk, a copied browser profile, synced or
 * backed-up extension storage read off-device, and any bug class that leaks
 * `chrome.storage.local` contents without code execution. It does NOT defend
 * against a compromised running browser or a malicious extension update —
 * once code runs with this extension's privileges it can read the unwrapped
 * seed from the session cache the same way the service worker does. Saying
 * otherwise would be security theater, and the popup's copy must not imply
 * more than this file states.
 *
 * WHY A PASSPHRASE AND NOT A PASSKEY. WebAuthn is not available on
 * `chrome-extension://` origins — an extension page has no valid RP ID, so
 * `navigator.credentials.create()` rejects — and deriving the wrapping key on
 * a WEB origin instead (the hosted wallet) would make extension custody
 * depend on a website, which is the dependency the extension tier exists to
 * remove. So the shipping KDF is a passphrase through PBKDF2-SHA-256, the
 * same shape password-manager extensions use. The `kdf` field exists so a
 * PRF-derived KEK slots in without a format change the day the platform
 * grows one (WebAuthn on extension origins, or an OS keystore reachable
 * without a web origin in the loop).
 *
 * The wrapped record carries the seed's own PUBLIC key. That is what makes
 * two rules checkable: an unwrap must yield the seed it claims to hold (a
 * wrong passphrase fails the AEAD tag, but a corrupted record must not
 * silently yield a different identity), and a migration may delete the
 * plaintext copy only after a round-trip through the wrapped copy reproduces
 * the same public key — never destroy the only copy of a key on faith.
 *
 * Chrome-free and pure (WebCrypto only), so `check.ts` drives every rule
 * directly: round-trip, wrong-passphrase refusal, tamper refusal, and the
 * migration ordering.
 */

import { publicKeyOf, type Hex } from '@agentport/protocol';

/**
 * OWASP's 2023+ floor for PBKDF2-HMAC-SHA256. Raising it later is free —
 * the record stores the iteration count it was written with, so old records
 * unwrap at their own cost and re-wrap at the new one on the next unlock.
 */
export const WRAP_ITERATIONS = 600_000;

export interface WrappedKey {
  v: 1;
  kdf: 'passphrase' | 'prf';
  /** PBKDF2 iterations for `kdf: 'passphrase'`; absent for prf. */
  iterations?: number;
  /** Hex-encoded random salt (16 bytes). */
  salt: string;
  /** Hex-encoded AES-GCM IV (12 bytes). */
  iv: string;
  /** Hex-encoded ciphertext (seed + GCM tag). */
  ciphertext: string;
  /** The wrapped seed's own public key — the identity this record claims. */
  publicKey: Hex;
}

const HEX = /^[0-9a-f]+$/;

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

function fromHex(hex: string): Uint8Array {
  if (!HEX.test(hex) || hex.length % 2 !== 0) throw new Error('not hex');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function passphraseKek(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Wrap a seed under a passphrase. The seed itself is never returned inside the record. */
export async function wrapSeed(seed: Hex, passphrase: string): Promise<WrappedKey> {
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('expected a 64-character hex seed');
  if (passphrase.length < 8) throw new Error('a wrapping passphrase must be at least 8 characters');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await passphraseKek(passphrase, salt, WRAP_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    kek,
    fromHex(seed) as BufferSource,
  );
  return {
    v: 1,
    kdf: 'passphrase',
    iterations: WRAP_ITERATIONS,
    salt: toHex(salt),
    iv: toHex(iv),
    ciphertext: toHex(new Uint8Array(ciphertext)),
    publicKey: publicKeyOf(seed),
  };
}

/**
 * Unwrap, or throw. A wrong passphrase fails the AEAD tag; a record whose
 * plaintext does not reproduce the public key it claims is refused even
 * though the tag verified, because an identity swap that authenticates is
 * exactly the corruption this field exists to catch.
 */
export async function unwrapSeed(wrapped: WrappedKey, passphrase: string): Promise<Hex> {
  if (wrapped.v !== 1 || wrapped.kdf !== 'passphrase') throw new Error('unsupported wrapped-key record');
  const iterations = wrapped.iterations ?? WRAP_ITERATIONS;
  const kek = await passphraseKek(passphrase, fromHex(wrapped.salt), iterations);
  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromHex(wrapped.iv) as BufferSource },
      kek,
      fromHex(wrapped.ciphertext) as BufferSource,
    );
  } catch {
    // WebCrypto's OperationError carries nothing; name the two real causes.
    throw new Error('wrong passphrase, or the wrapped key record is corrupt');
  }
  const seed = toHex(new Uint8Array(plaintext));
  if (!/^[0-9a-f]{64}$/.test(seed)) throw new Error('the wrapped record did not contain a seed');
  if (publicKeyOf(seed) !== wrapped.publicKey) {
    throw new Error('the wrapped record decrypted to a different identity than it claims');
  }
  return seed;
}

/**
 * Whether a plaintext copy may be deleted, given what the wrapped copy just
 * proved. Pure so the ordering rule is assertable: the ONLY input that
 * permits deletion is a successful unwrap reproducing the same public key —
 * "the write succeeded" is not evidence the record is readable.
 */
export function mayDeletePlaintext(plaintextSeed: Hex, roundTrip: { seed: Hex } | { failed: true }): boolean {
  return 'seed' in roundTrip && roundTrip.seed === plaintextSeed;
}
