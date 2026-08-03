/**
 * Key custody.
 *
 * `chrome.storage.local` is not a secure element — it is readable by anything
 * with the extension's own privileges, and by anyone with disk access to the
 * profile. What it *is* is unreachable from page JavaScript, which is the
 * entire point of moving the wallet out of the demo page. Hardening from here
 * (passkey-wrapped key, or no local key at all and a NIP-46 bunker doing the
 * signing) changes this file and nothing else, exactly as `crypto.ts` isolates
 * the identity layer on the protocol side.
 */

import { generateKeyPair, publicKeyOf, type Hex } from '@agentport/protocol';

const KEY_SECRET = 'agentport.user.secretKey';
const KEY_RELAY = 'agentport.relay.url';
const KEY_ALIAS_SEED = 'agentport.alias.seed';
const KEY_RESUME = 'agentport.resume.v1';

export const DEFAULT_RELAY_URL = 'wss://agentport.gogakoreli.workers.dev/relay';

async function read<T>(key: string): Promise<T | undefined> {
  const bag = await chrome.storage.local.get(key);
  return bag[key] as T | undefined;
}

/** The user key never leaves the service worker. Nothing exports it. */
export async function userSecretKey(): Promise<Hex | undefined> {
  const stored = await read<string>(KEY_SECRET);
  return typeof stored === 'string' && /^[0-9a-f]{64}$/.test(stored) ? stored : undefined;
}

export async function ensureUserKey(): Promise<Hex> {
  const existing = await userSecretKey();
  if (existing) return existing;
  const keys = generateKeyPair();
  await chrome.storage.local.set({ [KEY_SECRET]: keys.secretKey });
  return keys.secretKey;
}

export async function importUserKey(secretKey: string): Promise<Hex> {
  if (!/^[0-9a-f]{64}$/.test(secretKey)) throw new Error('expected a 64-character hex secret key');
  // Reject a key we cannot derive a public key from before overwriting one the
  // user may still have agents bound to.
  publicKeyOf(secretKey);
  await chrome.storage.local.set({ [KEY_SECRET]: secretKey });
  return secretKey;
}

export async function userPublicKey(): Promise<Hex | undefined> {
  const secret = await userSecretKey();
  return secret ? publicKeyOf(secret) : undefined;
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
