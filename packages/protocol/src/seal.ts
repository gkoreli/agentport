/**
 * End-to-end sealing of session frames (ADR-003).
 *
 * The relay terminates TLS, so without this it can read every prompt and tool
 * result it forwards. Sealing closes that: each side mints an ephemeral X25519
 * keypair per session attachment, proves it with an Ed25519 signature from its
 * long-term identity, and the shared secret (via HKDF) keys XChaCha20-Poly1305
 * over every content frame. The relay routes `{t:'enc', s, n, c}` and learns
 * nothing else — not the text, not even which kind of frame it carried.
 *
 * Properties, and their limits:
 *   - Forward secrecy: keys are per-attachment and never persisted; a stolen
 *     identity key cannot decrypt recorded past traffic.
 *   - Key-swap resistance: the relay cannot substitute its own epk without
 *     forging an Ed25519 signature it has no key for.
 *   - Drop-in first contact is TOFU: the page's identity is itself ephemeral
 *     and first seen through the relay, so a malicious relay could MITM the
 *     *first* exchange. The fingerprint words exist for exactly this — they
 *     are derived from both epks, so the browser and the daemon consent
 *     screen showing the same words proves nobody sat in the middle.
 *
 * All primitives come from the audited @noble libraries; nothing here invents
 * cryptography, it only fixes the recipe (the NaCl-box lineage: X25519 +
 * HKDF-SHA256 + XChaCha20-Poly1305).
 */

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { fromHex, randomBytes, sign, toHex, verify, type KeyPair } from './crypto.js';
import type { Hex, SessionFrame } from './messages.js';

/** One session attachment's ephemeral encryption keypair. Never reuse. */
export function generateSealKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomPrivateKey();
  return { secretKey: toHex(secretKey), publicKey: toHex(x25519.getPublicKey(secretKey)) };
}

/**
 * The message an identity key signs to vouch for an ephemeral key. `scope` is
 * the session id (or 'connect' before one exists) so a proof cannot be
 * replayed into a different session.
 */
export function epkProofMessage(scope: string, epk: Hex): string {
  return `agentport-epk:${scope}:${epk}`;
}

export function signEpk(identitySecretKey: Hex, scope: string, epk: Hex): Hex {
  return sign(identitySecretKey, epkProofMessage(scope, epk));
}

export function verifyEpk(identityPublicKey: Hex, scope: string, epk: Hex, sig: Hex): boolean {
  return verify(identityPublicKey, epkProofMessage(scope, epk), sig);
}

/**
 * Both sides call this with their own secret and the peer's public key and
 * arrive at the same 32-byte key. The session id goes into HKDF so two
 * sessions between the same peers never share a key even if an epk were
 * (wrongly) reused.
 */
export function deriveSealKey(mySecretKey: Hex, theirPublicKey: Hex, sessionId: string): Uint8Array {
  const shared = x25519.getSharedSecret(fromHex(mySecretKey), fromHex(theirPublicKey));
  return hkdf(sha256, shared, undefined, `agentport-seal:${sessionId}`, 32);
}

/** The only shape the relay sees for sealed traffic. */
export interface SealedFrame {
  t: 'enc';
  s: string;
  /** 24-byte XChaCha20 nonce, hex. Random per frame; the space is big enough. */
  n: Hex;
  /** Ciphertext + Poly1305 tag over the canonical JSON of the inner frame. */
  c: Hex;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function seal(key: Uint8Array, frame: SessionFrame): SealedFrame {
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(encoder.encode(JSON.stringify(frame)));
  return { t: 'enc', s: frame.s, n: toHex(nonce), c: toHex(ciphertext) };
}

/** Throws on tampering — Poly1305 rejects, we do not guess. */
export function openSealed(key: Uint8Array, sealed: SealedFrame): SessionFrame {
  const plaintext = xchacha20poly1305(key, fromHex(sealed.n)).decrypt(fromHex(sealed.c));
  const frame = JSON.parse(decoder.decode(plaintext)) as SessionFrame;
  if (frame.s !== sealed.s) throw new Error('sealed frame session id mismatch');
  return frame;
}

/**
 * Frame types that carry conversation or tool traffic and must be sealed.
 * Lifecycle frames (open/opened/resume/close/…) stay readable because the
 * relay needs them to route and to enforce its structural checks.
 */
export const SEALED_TYPES = new Set<string>([
  'prompt',
  'prompt.cancel',
  'delta',
  'thought',
  'done',
  'tool.call',
  'tool.result',
  'approval.request',
  'approval.response',
  'history.request',
  'history',
]);

// ---------------------------------------------------------------------------
// Fingerprint words — the human MITM check
// ---------------------------------------------------------------------------

/**
 * 256 short, phonetically distinct words. Three of them encode 24 bits of the
 * hash over both ephemeral keys. Matching words on the browser modal and the
 * daemon consent screen means both sides hold the same two keys — i.e. the
 * relay did not substitute its own.
 */
const WORDS = (
  'acid apex aqua arch atom aunt axis bald barn bath bead bear belt bird bison blade ' +
  'blaze bloom blush boat bolt bone book boot brass brick brook bud bulk buzz cabin cake ' +
  'calm camp cape card cave chalk charm chef chip claw clay cliff cloud coal coast coin ' +
  'cone coral cork corn crab crane crest crow cube cup curl dart dawn deer dew dice ' +
  'dome dove drift drum dusk dust eagle earth echo edge elk elm ember fable fang fern ' +
  'field fig fin fir flame flint foam fog fork fort fox frog frost fruit gale gate ' +
  'gem giant gift glen glow gold goose grain grape grove gulf gull gust hail harbor hawk ' +
  'hazel heron hill hive honey hoof horn husk ice inlet iris iron isle ivory ivy jade ' +
  'jaw jet jolt jug juno kale keel kelp kiln king kite knot lace lake lamb lark ' +
  'latch lava leaf ledge lily lime linen lion loft log loom lotus lynx mango maple marsh ' +
  'mast meadow mesa mint mist mole moon moss moth nest newt night noble north nut oak ' +
  'oasis ocean olive onyx opal orbit otter owl palm peak pearl pebble perch pine plum pond ' +
  'prism quail quartz quill rain ramp raven reed reef ridge river robin rock rose ruby rune ' +
  'rust sage sail salt sand seal shell shore silk slate snow spark spring spruce stag star ' +
  'stone storm swan thorn tide tiger torch trail tulip tundra twig vale vine wave whale ' +
  'wheat willow wind wolf wren yarn zebra zinc amber ash bay birch cedar clove daisy dune elder'
).split(/\s+/);

if (WORDS.length !== 256) throw new Error(`fingerprint wordlist must be 256 words, got ${WORDS.length}`);

/** Order-independent: both sides get the same words whoever lists first. */
export function fingerprintWords(epkA: Hex, epkB: Hex): string {
  const [lo, hi] = [epkA, epkB].sort();
  const digest = sha256(encoder.encode(`agentport-verify:${lo}:${hi}`));
  return `${WORDS[digest[0]!]}-${WORDS[digest[1]!]}-${WORDS[digest[2]!]}`;
}
