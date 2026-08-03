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
 * The channel state follows Noise's transport rules: independent keys per
 * direction, a monotonic 64-bit nonce, increment only after successful AEAD,
 * and terminal failure at nonce exhaustion. The session id is AEAD associated
 * data, binding ciphertext to its visible routing envelope.
 *
 * References for maintainers:
 * - Noise CipherState and Split: https://noiseprotocol.org/noise.html#the-cipherstate-object
 * - libsodium directional kx: https://doc.libsodium.org/key_exchange
 * - libsodium ordered streams: https://doc.libsodium.org/secret-key_cryptography/secretstream
 *
 * All primitives come from the audited @noble libraries already required by
 * the browser-safe protocol package. Do not replace this state machine with a
 * random-nonce convenience wrapper or add a plaintext compatibility path.
 */

import { sha256 } from '@noble/hashes/sha256';
import { decrypt, deriveSecureChannel, encrypt, generateEphemeralKeyPair, type CipherState, type SecureChannel } from './channel.js';
import { canonicalJson, sign, verify, type KeyPair } from './crypto.js';
import type { CapabilityGrant, Hex, SessionFrame, SurfaceDescriptor } from './messages.js';

/** One session attachment's ephemeral encryption keypair. Never reuse. */
export function generateSealKeyPair(): KeyPair {
  return generateEphemeralKeyPair();
}

/**
 * The message an identity key signs to vouch for an ephemeral key. `scope` is
 * the session id (or 'connect' before one exists) so a proof cannot be
 * replayed into a different session.
 */
export function epkProofMessage(scope: string, epk: Hex, binding: unknown): string {
  return `agentport-epk-v1:${canonicalJson({ scope, epk, binding })}`;
}

export function signEpk(identitySecretKey: Hex, scope: string, epk: Hex, binding: unknown): Hex {
  return sign(identitySecretKey, epkProofMessage(scope, epk, binding));
}

export function verifyEpk(identityPublicKey: Hex, scope: string, epk: Hex, sig: Hex, binding: unknown): boolean {
  return verify(identityPublicKey, epkProofMessage(scope, epk, binding), sig);
}

/**
 * Noise calls this handshake context the prologue: clear lifecycle metadata is
 * not secret, but both endpoints must authenticate the same view so the relay
 * cannot rewrite a capability grant, origin, mode, peer, or resume authority.
 */
export function openProofBinding(
  mode: 'open' | 'connect',
  surface: SurfaceDescriptor,
  grant: CapabilityGrant,
  agent?: Hex,
): unknown {
  return { mode, surface, grant, ...(agent ? { agent } : {}) };
}

export function resumeProofBinding(agent: Hex, token: string): unknown {
  return { mode: 'resume', agent, token };
}

export function answerProofBinding(
  mode: 'open' | 'connect' | 'resume',
  client: Hex,
  clientEpk: Hex,
  surface: SurfaceDescriptor,
  grant: CapabilityGrant,
  details: { agentName: string; runtime: string; resume?: string; missed?: number },
): unknown {
  return { mode, client, clientEpk, surface, grant, details };
}

/**
 * Both sides call this with their own secret and the peer's public key and
 * arrive at the same directional keys. The session id goes into HKDF so two
 * sessions never share transport keys even if an epk were wrongly reused.
 */
export type SealCipherState = CipherState;
export type SealChannel = SecureChannel;

/**
 * Derive independent transport keys for each direction, as Noise Split and
 * libsodium crypto_kx do. Separate keys make counter nonces safe even though
 * both directions begin at zero.
 */
export function deriveSealChannel(
  mySecretKey: Hex,
  theirPublicKey: Hex,
  sessionId: string,
  role: 'client' | 'agent',
): SealChannel {
  return deriveSecureChannel(
    mySecretKey,
    theirPublicKey,
    'agentport-seal-v1',
    sessionId,
    role === 'client' ? 'initiator' : 'responder',
  );
}

/** The only shape the relay sees for sealed traffic. */
export interface SealedFrame {
  t: 'enc';
  s: string;
  /** 24-byte XChaCha20 nonce; its final 8 bytes are a monotonic counter. */
  n: Hex;
  /** Ciphertext + Poly1305 tag over the inner frame JSON. */
  c: Hex;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function associatedData(sessionId: string): Uint8Array {
  return encoder.encode(`agentport-seal-v1:${sessionId}`);
}

export function seal(state: SealCipherState, frame: SessionFrame): SealedFrame {
  const sealed = encrypt(state, encoder.encode(JSON.stringify(frame)), associatedData(frame.s));
  return { t: 'enc', s: frame.s, n: sealed.nonce, c: sealed.ciphertext };
}

/** Throws on tampering, replay, reordering, or nonce exhaustion. */
export function openSealed(state: SealCipherState, sealed: SealedFrame): SessionFrame {
  const plaintext = decrypt(
    state,
    { nonce: sealed.n, ciphertext: sealed.c },
    associatedData(sealed.s),
  );
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
 * 256 short, phonetically distinct words. Six encode 48 bits of the hash over
 * both ephemeral keys. This is a short authentication string for deliberate
 * human comparison, not a substitute for a pinned identity. Forty-eight bits
 * makes an online relay's chosen-prefix search impractical while keeping the
 * consent check readable.
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
  return [...digest.slice(0, 6)].map((byte) => WORDS[byte]!).join('-');
}
