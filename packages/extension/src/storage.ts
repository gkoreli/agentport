/**
 * Key custody.
 *
 * `chrome.storage.local` is not a secure element — it is readable by anything
 * with the extension's own privileges, and by anyone with disk access to the
 * profile. What it *is* is unreachable from page JavaScript, which is the
 * entire point of moving the wallet out of the demo page.
 *
 * The root seed has two at-rest forms, and the difference is SURFACED, never
 * papered over:
 *
 *   wrapped — the durable copy is AES-GCM ciphertext under a passphrase-derived
 *             key (`keywrap.ts` holds the crypto and the threat model: this
 *             protects the seed at rest, not against a compromised running
 *             browser). The UNWRAPPED seed lives only in
 *             `chrome.storage.session` — extension-contexts only, memory-only,
 *             gone when the browser exits — populated by an unlock in the
 *             popup, once per browser session. A cold cache is the LOCKED
 *             state: operations that need the key fail into "unlock AgentPort
 *             in the popup", never into a silent throw.
 *   legacy  — plaintext hex, the pre-wrapping format. Still usable, so an
 *             existing user is not locked out of their own agents by an
 *             update, and reported as `legacy` so the popup can say
 *             "unprotected" and offer the upgrade. Migration wraps, VERIFIES
 *             the wrapped copy round-trips to the same identity, and only
 *             then deletes the plaintext — never destroy the only copy.
 *
 * A NIP-46 bunker (no local key at all) still changes this file and nothing
 * else, exactly as `crypto.ts` isolates the identity layer on the protocol
 * side.
 */

import { generateKeyPair, publicKeyOf, type Hex } from '@agentport/protocol';
import { ENABLED_ORIGINS_KEY, isEnableableOrigin } from './enablement.js';
import { mayDeletePlaintext, unwrapSeed, wrapSeed, type WrappedKey } from './keywrap.js';

const KEY_SECRET = 'agentport.user.secretKey';
const KEY_WRAPPED = 'agentport.user.wrapped.v1';
const KEY_UNLOCKED = 'agentport.user.unlocked.v1';
const KEY_RELAY = 'agentport.relay.url';
const KEY_ALIAS_SEED = 'agentport.alias.seed';
const KEY_RESUME = 'agentport.resume.v1';

export const DEFAULT_RELAY_URL = 'wss://agentport.gogakoreli.workers.dev/relay';

async function read<T>(key: string): Promise<T | undefined> {
  const bag = await chrome.storage.local.get(key);
  return bag[key] as T | undefined;
}

/** Every custody state the popup must be able to name. */
export type CustodyState =
  | { state: 'none' }
  /** Plaintext at rest — usable, unprotected, and said so. */
  | { state: 'legacy'; publicKey: Hex }
  /** Wrapped at rest, session cache cold: unusable until an unlock. */
  | { state: 'locked'; publicKey: Hex }
  /** Wrapped at rest, unwrapped copy warm in session storage. */
  | { state: 'unlocked'; publicKey: Hex };

function isSeed(value: unknown): value is Hex {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

async function legacySeed(): Promise<Hex | undefined> {
  const stored = await read<string>(KEY_SECRET);
  return isSeed(stored) ? stored : undefined;
}

async function wrappedRecord(): Promise<WrappedKey | undefined> {
  const stored = await read<WrappedKey>(KEY_WRAPPED);
  return stored && typeof stored === 'object' && stored.v === 1 ? stored : undefined;
}

async function sessionSeed(): Promise<Hex | undefined> {
  const bag = await chrome.storage.session.get(KEY_UNLOCKED);
  const value = bag[KEY_UNLOCKED];
  return isSeed(value) ? value : undefined;
}

export async function custodyState(): Promise<CustodyState> {
  const wrapped = await wrappedRecord();
  if (wrapped) {
    const unlocked = await sessionSeed();
    // The cache must belong to THIS wrapped record: an import that replaced
    // the identity while a stale unlock was cached must read as locked, not
    // as unlocked-with-the-wrong-key.
    if (unlocked && publicKeyOf(unlocked) === wrapped.publicKey) {
      return { state: 'unlocked', publicKey: wrapped.publicKey };
    }
    return { state: 'locked', publicKey: wrapped.publicKey };
  }
  const legacy = await legacySeed();
  if (legacy) return { state: 'legacy', publicKey: publicKeyOf(legacy) };
  return { state: 'none' };
}

/**
 * The user key never leaves the service worker. Nothing exports it.
 *
 * `undefined` means "not usable RIGHT NOW", which is two different situations
 * — no identity, or a locked one — and callers that surface an error to a
 * person must ask `custodyState()` for which, because "create an identity"
 * and "unlock in the popup" are different instructions.
 */
export async function userSecretKey(): Promise<Hex | undefined> {
  const wrapped = await wrappedRecord();
  if (wrapped) {
    const unlocked = await sessionSeed();
    return unlocked && publicKeyOf(unlocked) === wrapped.publicKey ? unlocked : undefined;
  }
  return legacySeed();
}

/**
 * Create-if-missing, in the LEGACY (plaintext) format.
 *
 * Kept deliberately: the load-unpacked developer flow and the check harness
 * need an identity without an interactive passphrase, and an existing user's
 * plaintext key must go on working. The popup's own create flow passes a
 * passphrase and never lands here (`createProtectedKey`); an identity created
 * this way is reported as `legacy` and the popup shows it as unprotected.
 */
export async function ensureUserKey(): Promise<Hex> {
  const existing = await userSecretKey();
  if (existing) return existing;
  if (await wrappedRecord()) throw new Error('the identity is locked — unlock AgentPort in the popup');
  const keys = generateKeyPair();
  await chrome.storage.local.set({ [KEY_SECRET]: keys.secretKey });
  return keys.secretKey;
}

/** Create a fresh identity already wrapped — the popup's create flow. */
export async function createProtectedKey(passphrase: string): Promise<Hex> {
  const state = await custodyState();
  if (state.state !== 'none') throw new Error('an identity already exists — import or unlock instead');
  const keys = generateKeyPair();
  const wrapped = await wrapSeed(keys.secretKey, passphrase);
  await chrome.storage.local.set({ [KEY_WRAPPED]: wrapped });
  await chrome.storage.session.set({ [KEY_UNLOCKED]: keys.secretKey });
  return keys.secretKey;
}

/**
 * Wrap the existing legacy key under a passphrase, verify, then delete the
 * plaintext. Ordering is the whole function: the plaintext copy is deleted
 * ONLY after the freshly written wrapped record has been read back and
 * unwrapped to the same identity (`keywrap.ts#mayDeletePlaintext`) — a wrap
 * that wrote garbage must leave the user exactly where they were.
 */
export async function protectExistingKey(passphrase: string): Promise<void> {
  const legacy = await legacySeed();
  if (!legacy) throw new Error('no unprotected identity to protect');
  if (await wrappedRecord()) throw new Error('the identity is already protected');
  await chrome.storage.local.set({ [KEY_WRAPPED]: await wrapSeed(legacy, passphrase) });
  const readBack = await wrappedRecord();
  let roundTrip: { seed: Hex } | { failed: true };
  try {
    roundTrip = readBack ? { seed: await unwrapSeed(readBack, passphrase) } : { failed: true };
  } catch {
    roundTrip = { failed: true };
  }
  if (!mayDeletePlaintext(legacy, roundTrip)) {
    // The wrapped copy is not trustworthy; withdraw it rather than the seed.
    await chrome.storage.local.remove(KEY_WRAPPED);
    throw new Error('the wrapped copy did not verify; the identity is unchanged');
  }
  await chrome.storage.session.set({ [KEY_UNLOCKED]: legacy });
  await chrome.storage.local.remove(KEY_SECRET);
}

/** Unlock for this browser session. Throws the unwrap's own refusal on a wrong passphrase. */
export async function unlockKey(passphrase: string): Promise<void> {
  const wrapped = await wrappedRecord();
  if (!wrapped) throw new Error('nothing is locked');
  const seed = await unwrapSeed(wrapped, passphrase);
  await chrome.storage.session.set({ [KEY_UNLOCKED]: seed });
}

export async function importUserKey(secretKey: string): Promise<Hex> {
  if (!/^[0-9a-f]{64}$/.test(secretKey)) throw new Error('expected a 64-character hex secret key');
  // Reject a key we cannot derive a public key from before overwriting one the
  // user may still have agents bound to.
  publicKeyOf(secretKey);
  // An import replaces the identity outright, in the legacy format; the popup
  // offers protection as the next step. The stale session cache and any
  // wrapped record for the OLD identity must not survive it.
  await chrome.storage.local.set({ [KEY_SECRET]: secretKey });
  await chrome.storage.local.remove(KEY_WRAPPED);
  await chrome.storage.session.remove(KEY_UNLOCKED);
  return secretKey;
}

export async function userPublicKey(): Promise<Hex | undefined> {
  const state = await custodyState();
  return state.state === 'none' ? undefined : state.publicKey;
}

export async function relayUrl(): Promise<string> {
  const stored = await read<string>(KEY_RELAY);
  return typeof stored === 'string' && /^wss?:\/\//.test(stored) ? stored : DEFAULT_RELAY_URL;
}

export async function setRelayUrl(url: string): Promise<string> {
  if (!/^wss?:\/\/[^\s]+$/.test(url)) throw new Error('relay must be a ws:// or wss:// url');
  await chrome.storage.local.set({ [KEY_RELAY]: url });
  return url;
}

// --- per-origin enablement (the page-visible existence switch) --------------
//
// Default OFF: an origin the user has not enabled gets no provider, no shim,
// no FAB — nothing a page can observe (`enablement.ts` holds the reasoning
// and the pure rules; the service worker holds the script registration this
// list drives). `chrome.storage.local`, because enablement is a durable
// user decision, and the sw re-syncs from `storage.onChanged` so every
// writer converges through one path.

export async function enabledOrigins(): Promise<string[]> {
  const stored = await read<unknown>(ENABLED_ORIGINS_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.filter((entry): entry is string => typeof entry === 'string' && isEnableableOrigin(entry));
}

export async function isOriginEnabled(origin: string): Promise<boolean> {
  return (await enabledOrigins()).includes(origin);
}

export async function setOriginEnabled(origin: string, enabled: boolean): Promise<string[]> {
  if (!isEnableableOrigin(origin)) throw new Error(`not an enableable origin: ${origin}`);
  const current = await enabledOrigins();
  const next = enabled ? [...new Set([...current, origin])] : current.filter((entry) => entry !== origin);
  await chrome.storage.local.set({ [ENABLED_ORIGINS_KEY]: next });
  return next;
}

// --- per-origin aliases (ADR-009) ------------------------------------------
//
// What a page may learn about the user's agent is a label that is stable for
// THAT origin and meaningless everywhere else. The alias is a one-way hash of
// a random per-install seed and the origin — deterministic per origin, so the
// site keeps its UX continuity across visits, and uncorrelatable across
// origins, so two sites comparing notes learn nothing. The seed is NOT the
// user key: even a full break of the hash would expose a random number.

function toHexString(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

async function aliasSeed(): Promise<string> {
  const existing = await read<string>(KEY_ALIAS_SEED);
  if (typeof existing === 'string' && existing.length >= 32) return existing;
  const seed = toHexString(crypto.getRandomValues(new Uint8Array(32)));
  await chrome.storage.local.set({ [KEY_ALIAS_SEED]: seed });
  return seed;
}

/** Stable within one origin, uncorrelatable across origins. */
export async function originAlias(origin: string): Promise<string> {
  const seed = await aliasSeed();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${seed}|${origin}`));
  return `a_${toHexString(new Uint8Array(digest)).slice(0, 16)}`;
}

// --- resume records --------------------------------------------------------
//
// The service worker's in-memory session table dies with the worker (MV3
// evicts idle workers); the relay-side session does not. These records carry
// just enough to re-attach — session id, agent identity, and resume token.
// `chrome.storage.session` on purpose: extension-contexts only, page JS can
// never reach it, and it dies with the browser session exactly like the
// grant-scoped token it holds.

export interface StoredResume {
  id: string;
  /** The agent the session lives on — resume routes by it (stateless relay). */
  agent: string;
  token: string;
  origin: string;
  name: string;
  expiresAt: number;
}

type ResumeBag = Record<string, StoredResume>;

function resumeKey(origin: string, name: string): string {
  return `${origin}\n${name}`;
}

async function resumeBag(): Promise<ResumeBag> {
  const bag = await chrome.storage.session.get(KEY_RESUME);
  const value = bag[KEY_RESUME];
  return typeof value === 'object' && value !== null ? (value as ResumeBag) : {};
}

export async function saveResume(record: StoredResume): Promise<void> {
  const bag = await resumeBag();
  bag[resumeKey(record.origin, record.name)] = record;
  await chrome.storage.session.set({ [KEY_RESUME]: bag });
}

export async function loadResume(origin: string, name: string): Promise<StoredResume | undefined> {
  return (await resumeBag())[resumeKey(origin, name)];
}

/** Only the caller who knows the session id may erase a record — a stale
 *  close for a session that was already replaced must not delete its heir. */
export async function clearResume(origin: string, name: string, sessionId: string): Promise<void> {
  const bag = await resumeBag();
  const key = resumeKey(origin, name);
  if (bag[key]?.id !== sessionId) return;
  delete bag[key];
  await chrome.storage.session.set({ [KEY_RESUME]: bag });
}

/** Every resume record — the standing authority the popup must SHOW, because
 *  a record that can re-attach is authority whether or not the worker's
 *  in-memory table currently knows a live session for it. */
export async function listResumes(): Promise<StoredResume[]> {
  return Object.values(await resumeBag());
}

/**
 * Erase every record for one (origin, agent) pair — the REVOKE eraser, which
 * is why it deliberately does not take a session id: revocation withdraws the
 * standing authority itself, heirs included. `clearResume` above stays the
 * lifecycle eraser with its stale-close guard; the two answer different
 * questions and must not be merged into one function with a flag.
 */
export async function clearResumesFor(origin: string, agent: string): Promise<void> {
  const bag = await resumeBag();
  let changed = false;
  for (const [key, record] of Object.entries(bag)) {
    if (record.origin !== origin || record.agent !== agent) continue;
    delete bag[key];
    changed = true;
  }
  if (changed) await chrome.storage.session.set({ [KEY_RESUME]: bag });
}

// --- the durable agent directory (ADR-016) ---------------------------------
// The relay is stateless and can only say who is online RIGHT NOW. The wallet
// signed the ownership certs, so the wallet is where the list of your agents
// durably lives.

const KEY_CERTS = 'agentport.certs';

export interface StoredCert {
  agent: string;
  name: string;
  runtime: string;
  location?: string;
}

export async function saveCert(cert: StoredCert): Promise<void> {
  const bag = await chrome.storage.local.get(KEY_CERTS);
  const list = (bag[KEY_CERTS] as StoredCert[] | undefined) ?? [];
  const next = [...list.filter((entry) => entry.agent !== cert.agent), cert];
  await chrome.storage.local.set({ [KEY_CERTS]: next });
}

export async function loadCerts(): Promise<StoredCert[]> {
  const bag = await chrome.storage.local.get(KEY_CERTS);
  return (bag[KEY_CERTS] as StoredCert[] | undefined) ?? [];
}
