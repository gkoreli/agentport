/**
 * Transport-agnostic authenticated channel state.
 *
 * This module knows bytes, roles, and a domain-separated channel context. It
 * deliberately knows nothing about AgentPort frames, grants, relays, or
 * identities; those belong in the protocol adapter (`seal.ts`).
 *
 * The state machine follows these open specifications:
 * - Noise CipherState and Split: https://noiseprotocol.org/noise.html#the-cipherstate-object
 * - libsodium directional kx: https://doc.libsodium.org/key_exchange
 * - libsodium ordered streams: https://doc.libsodium.org/secret-key_cryptography/secretstream
 */

import { x25519 } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { fromHex, toHex, type KeyPair } from './crypto.js';
import type { Hex } from './messages.js';

export interface CipherState {
  readonly key: Uint8Array;
  nonce: bigint;
}

export interface SecureChannel {
  readonly send: CipherState;
  readonly receive: CipherState;
}

export interface Ciphertext {
  nonce: Hex;
  ciphertext: Hex;
}

export function generateEphemeralKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey: toHex(secretKey), publicKey: toHex(x25519.getPublicKey(secretKey)) };
}

/**
 * Derives distinct keys for each direction. `protocol` must be a stable domain
 * separator and `context` must uniquely name this channel attachment.
 */
export function deriveSecureChannel(
  mySecretKey: Hex,
  theirPublicKey: Hex,
  protocol: string,
  context: string,
  role: 'initiator' | 'responder',
): SecureChannel {
  const shared = x25519.getSharedSecret(fromHex(mySecretKey), fromHex(theirPublicKey));
  // RFC 7748 section 6 requires protocols to abort on an all-zero result.
  if (shared.every((byte) => byte === 0)) throw new Error('invalid X25519 peer key');
  const initiatorToResponder = hkdf(sha256, shared, undefined, `${protocol}:${context}:initiator-to-responder`, 32);
  const responderToInitiator = hkdf(sha256, shared, undefined, `${protocol}:${context}:responder-to-initiator`, 32);
  const state = (key: Uint8Array): CipherState => ({ key, nonce: 0n });
  return role === 'initiator'
    ? { send: state(initiatorToResponder), receive: state(responderToInitiator) }
    : { send: state(responderToInitiator), receive: state(initiatorToResponder) };
}

const MAX_NONCE = (1n << 64n) - 1n;

function nonceBytes(counter: bigint): Uint8Array {
  if (counter < 0n || counter >= MAX_NONCE) throw new Error('channel nonce exhausted');
  const nonce = new Uint8Array(24);
  new DataView(nonce.buffer).setBigUint64(16, counter);
  return nonce;
}

export function encrypt(state: CipherState, plaintext: Uint8Array, associatedData: Uint8Array): Ciphertext {
  const nonce = nonceBytes(state.nonce);
  const ciphertext = xchacha20poly1305(state.key, nonce, associatedData).encrypt(plaintext);
  state.nonce++;
  return { nonce: toHex(nonce), ciphertext: toHex(ciphertext) };
}

/**
 * A frame whose nonce is not the one this side expects — replayed, skipped,
 * or fabricated. Deliberately NOT a WireViolation: the nonce is compared
 * before the AEAD tag is checked, so anyone on the path can produce this
 * without holding a key. Treating it as a peer protocol violation would hand
 * a passive intermediary a session kill switch. State is untouched, so the
 * caller drops the frame and the channel remains usable for the real next
 * one; if a frame truly was skipped the session stalls, which liveness
 * timeouts handle — a stall is recoverable, a teardown is not.
 */
export class NonceMismatchError extends Error {
  constructor() {
    super('channel nonce out of sequence');
    this.name = 'NonceMismatchError';
  }
}

/**
 * Advances state only after nonce and AEAD authentication both succeed.
 * The incoming nonce is never echoed into the error — it is attacker-supplied
 * bytes and stays out of every message and log.
 */
export function decrypt(state: CipherState, message: Ciphertext, associatedData: Uint8Array): Uint8Array {
  const nonce = nonceBytes(state.nonce);
  if (message.nonce !== toHex(nonce)) throw new NonceMismatchError();
  const plaintext = xchacha20poly1305(state.key, nonce, associatedData).decrypt(fromHex(message.ciphertext));
  state.nonce++;
  return plaintext;
}
