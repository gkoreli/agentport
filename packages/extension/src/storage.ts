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

export const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8787';

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
