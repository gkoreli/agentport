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
import {
  AGENT_SEALABLE,
  CLIENT_SEALABLE,
  type CapabilityGrant,
  type Hex,
  type Role,
  type SessionFrame,
  type SurfaceDescriptor,
} from './messages.js';
import { MAX_SEALED_PLAINTEXT_BYTES } from './limits.js';
import { WireViolation } from './schema.js';
import { decodeFrame, encodeFrame } from './wire.js';

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
  details: {
    agentName: string;
    runtime: string;
    resume?: string;
    missed?: number;
    /**
     * Whether the agent may use its own capabilities here (ADR-024 R11).
     * Bound, not merely sent: the page renders this to the user, and a relay
     * able to flip it could make the page claim an authority the daemon will
     * refuse — or hide a restriction the user needs to know about.
     */
    ownTools: boolean;
  },
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
/**
 * Fatal on purpose: a lenient decoder replaces malformed UTF-8 with U+FFFD,
 * which would let two distinct ciphertexts decode to the same frame text and
 * silently defeat the canonical-form check downstream.
 */
// Both options spelled out: the Workers type definitions require ignoreBOM,
// the DOM ones default it — and this file compiles under both lib sets.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function associatedData(sessionId: string): Uint8Array {
  return encoder.encode(`agentport-seal-v1:${sessionId}`);
}

/**
 * Seals a frame — and refuses to seal one the receiver would reject.
 *
 * Everything here happens BEFORE `encrypt()` advances the send counter, so a
 * local bug (a runtime handing us an oversized string, a tool result with
 * unbounded nesting, a text split through a surrogate pair) fails loudly at
 * its source instead of arriving as a protocol violation that tears down the
 * peer's session.
 */
export function seal(state: SealCipherState, frame: SessionFrame): SealedFrame {
  // encodeFrame, not JSON.stringify: the inner frame must be canonical or the
  // receiver's decodeFrame will reject it after decryption. decodeFrame here
  // is the same check the receiver will run — if it throws, we built a frame
  // we had no business sending.
  const wire = encodeFrame(frame);
  decodeFrame(wire);
  const plaintext = encoder.encode(wire);
  if (plaintext.length > MAX_SEALED_PLAINTEXT_BYTES) throw new WireViolation('oversize', 'enc');
  const sealed = encrypt(state, plaintext, associatedData(frame.s));
  return { t: 'enc', s: frame.s, n: sealed.nonce, c: sealed.ciphertext };
}

/**
 * Throws on tampering, replay, reordering, nonce exhaustion — and, since
 * ADR-019 §1, on any inner frame that fails strict validation: an oversized
 * plaintext, a non-canonical or malformed inner JSON, a frame type that is
 * not sealable at all, or one the sending side (`from`) may not originate.
 * The relay cannot see inside `enc`, so this is where the per-direction
 * origination rule lives — one implementation for both the daemon (receiving
 * from the client) and the wallet (receiving from the agent).
 *
 * Callers must treat the two failure classes differently:
 *  - decrypt failures (tamper, replay, wrong nonce) throw plain Errors and
 *    advance nothing. They are NOT peer-authenticated — an on-path relay can
 *    inject garbage — so the caller logs and drops the frame; the channel
 *    stays usable for the next authentic frame.
 *  - WireViolation is thrown only AFTER authentication succeeded: the peer
 *    itself sealed an invalid or forbidden inner frame. That is a protocol
 *    violation by an authenticated party and is session-fatal — close with a
 *    stable reason, never silently drop.
 */
export function openSealed(state: SealCipherState, sealed: SealedFrame, from: Role): SessionFrame {
  const plaintext = decrypt(
    state,
    { nonce: sealed.n, ciphertext: sealed.c },
    associatedData(sealed.s),
  );
  if (plaintext.length > MAX_SEALED_PLAINTEXT_BYTES) throw new WireViolation('oversize', 'enc');
  let text: string;
  try {
    text = decoder.decode(plaintext);
  } catch {
    // The AEAD tag already verified, so these bytes are the peer's own: it
    // sealed something that is not UTF-8. That is a protocol violation, not
    // the droppable class — surface it as one rather than letting a raw
    // TypeError be misread as a decrypt failure.
    throw new WireViolation('bad_format', 'enc');
  }
  const frame = decodeFrame(text);
  if (!SEALED_TYPES.has(frame.t)) throw new WireViolation('forbidden', 'enc');
  const allowed = from === 'client' ? CLIENT_SEALABLE : AGENT_SEALABLE;
  if (!allowed.has(frame.t)) throw new WireViolation('forbidden', 'enc');
  const inner = frame as SessionFrame;
  if (inner.s !== sealed.s) throw new WireViolation('mismatch', 'enc.s');
  return inner;
}

/**
 * Frame types that carry conversation or tool traffic and must be sealed.
 * Lifecycle frames (open/opened/resume/close/…) stay readable because the
 * relay needs them to route and to enforce its structural checks. Derived
 * from the two per-direction sets so the three can never drift.
 */
export const SEALED_TYPES = new Set<string>([...CLIENT_SEALABLE, ...AGENT_SEALABLE]);

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
