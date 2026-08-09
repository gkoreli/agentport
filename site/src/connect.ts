/**
 * connect.js — the three-tier connection ladder.
 *
 * A site adds one script tag and gets `AgentPort.connect()`. That's the whole
 * integration, in the same spirit as embedding Stripe/Link: the merchant page
 * renders a component and never touches the sensitive material.
 *
 * An installed extension wins. Without one, a popup on the wallet's own
 * origin can remember the user's key and certs across sites, then delegate to
 * this page's fresh key. If popups are unavailable, the original code-carrying
 * flow remains the universal fallback.
 */

import {
  AgentWallet,
  ResumeError,
  buildGrant,
  type AgentConnectRequest,
  type AgentProvider,
  type AgentSession,
  type AgentSessionHandle,
} from '@agentport/client';
import {
  ID_PATTERN,
  TOKEN_PATTERN,
  delegationLifetimeOk,
  generateKeyPair,
  hashGrant,
  publicKeyOf,
  randomId,
  toErr,
  type CapabilityGrant,
  type SessionDelegation,
} from '@agentport/protocol';
import { openConnectModal } from './modal.js';
import { createWebMcpHarvester } from './webmcp.js';
import { siteLogger } from './observe.js';
import {
  WALLET_CHANNEL,
  type WalletConnectResult,
  type WalletInbound,
  type WalletOutbound,
} from '../../wallet/src/handshake.js';

const log = siteLogger.child('connect');

const PRODUCTION_WALLET_ORIGIN = 'https://agentport-wallet.gogakoreli.workers.dev';
const DEFAULT_WALLET_ORIGIN = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
  ? 'http://127.0.0.1:8790'
  : PRODUCTION_WALLET_ORIGIN;
const POPUP_HANDSHAKE_TIMEOUT_MS = 20_000;

const embedScript =
  document.currentScript ??
  [...document.scripts].find((script) => {
    try {
      return new URL(script.src, location.href).pathname.endsWith('/connect.js');
    } catch {
      return false;
    }
  });

function scriptAttribute(name: string): string | null {
  return embedScript?.getAttribute(name) ?? null;
}

function relayUrl(): string {
  const configured = scriptAttribute('data-relay');
  if (configured) return configured;
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/relay`;
}

function walletUrl(): URL {
  const configured = scriptAttribute('data-wallet') ?? DEFAULT_WALLET_ORIGIN;
  const base = new URL(configured, location.href);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(base.hostname))) {
    throw new Error('the hosted wallet must use HTTPS (HTTP is allowed only on localhost)');
  }
  return new URL('/connect', base);
}

const RELAY = relayUrl();
const WALLET_URL = walletUrl();
const WALLET_ORIGIN = WALLET_URL.origin;
const webMcp = createWebMcpHarvester({
  document: document as Document & { modelContext?: unknown },
  navigator: navigator as Navigator & { modelContext?: unknown },
});

/**
 * Where a resumable session is remembered.
 *
 * sessionStorage, not localStorage: it is per-tab and dies when the tab
 * closes, which matches what the resume capability grants — re-attaching the
 * SAME bounded attachment identity to a session the user already approved,
 * whose grant/delegation still expire on their own schedules. It is
 * deliberately NOT the "remember my agents across sites" feature and never
 * stores the user's root identity.
 */
const RESUME_KEY = 'agentport.session';

/**
 * Keyed per surface: a tab that moves between two surfaces of one site (or a
 * user who bounces between demo pages) holds one resumable session per
 * surface, instead of each connect overwriting the last one.
 */
function resumeKeyFor(surface: string): string {
  return `${RESUME_KEY}:${surface}`;
}

interface ResumeRecord {
  id: string;
  /** The agent the session lives on — resume routes by it (stateless relay). */
  agent: string;
  /** Bounded identity of this attachment only; never the user's root key. */
  clientSecretKey: string;
  token: string;
  relay: string;
  surface: string;
}

const RESUME_RECORD_KEYS = ['agent', 'clientSecretKey', 'id', 'relay', 'surface', 'token'] as const;
const MAX_RESUME_RECORD_CHARS = 4096;

function rememberSession(record: ResumeRecord): void {
  try {
    sessionStorage.setItem(resumeKeyFor(record.surface), JSON.stringify(record));
  } catch (err) {
    log.warn('could not persist session for resume', { err, data: { surface: record.surface } });
  }
}

function forgetSession(surface: string): void {
  try {
    sessionStorage.removeItem(resumeKeyFor(surface));
  } catch {
    // storage disabled; resume simply will not be offered
  }
}

function rememberedSession(surface: string): ResumeRecord | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(resumeKeyFor(surface));
  } catch {
    // Blocked storage means there is safely no resumable session.
    return null;
  }
  if (!raw) return null;

  let value: unknown;
  try {
    if (raw.length > MAX_RESUME_RECORD_CHARS) throw new Error('resume record is too large');
    value = JSON.parse(raw);
  } catch {
    forgetSession(surface);
    log.warn('discarded malformed session resume record', { data: { surface } });
    return null;
  }

  if (!isRecord(value)) {
    forgetSession(surface);
    log.warn('discarded incomplete or invalid session resume record', { data: { surface } });
    return null;
  }
  const exactKeys = Object.keys(value).length === RESUME_RECORD_KEYS.length
    && RESUME_RECORD_KEYS.every((key) => Object.hasOwn(value, key));
  if (
    !exactKeys ||
    typeof value['id'] !== 'string' ||
    !ID_PATTERN.test(value['id']) ||
    typeof value['agent'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value['agent']) ||
    typeof value['clientSecretKey'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value['clientSecretKey']) ||
    typeof value['token'] !== 'string' ||
    !TOKEN_PATTERN.test(value['token']) ||
    value['relay'] !== RELAY ||
    value['surface'] !== surface
  ) {
    forgetSession(surface);
    log.warn('discarded incomplete or invalid session resume record', { data: { surface } });
    return null;
  }

  // Validate that the stored scalar is usable as an Ed25519 key before it is
  // handed to AgentWallet. Rebuild a fresh exact object so storage prototypes
  // and unknown properties never cross this boundary.
  try {
    publicKeyOf(value['clientSecretKey']);
  } catch {
    forgetSession(surface);
    log.warn('discarded invalid attachment identity in session resume record', { data: { surface } });
    return null;
  }
  return {
    id: value['id'],
    agent: value['agent'],
    clientSecretKey: value['clientSecretKey'],
    token: value['token'],
    relay: RELAY,
    surface,
  };
}

// ---------------------------------------------------------------------------

type HostedUnavailableReason = 'popup_blocked' | 'popup_closed' | 'handshake_timeout';

class HostedWalletUnavailable extends Error {
  constructor(readonly reason: HostedUnavailableReason) {
    super(`hosted wallet unavailable: ${reason}`);
  }
}

function popupFeatures(): string {
  const width = 480;
  const height = 690;
  const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
  const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));
  return `popup=yes,width=${width},height=${height},left=${left},top=${top}`;
}

function openWalletPopup(url: string): Window | null {
  return window.open(url, `agentport_wallet_${randomId()}`, popupFeatures());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function requestHostedDelegation(
  request: AgentConnectRequest,
  grant: CapabilityGrant,
  delegate: ReturnType<typeof generateKeyPair>,
  preopened?: Window | null,
): Promise<WalletConnectResult> {
  const popup = preopened === undefined ? openWalletPopup(WALLET_URL.href) : preopened;
  if (!popup) throw new HostedWalletUnavailable('popup_blocked');

  // AgentPort.connect pre-opens about:blank synchronously to preserve the
  // click's popup permission while extension discovery finishes.
  try {
    if (popup.location.href === 'about:blank') popup.location.replace(WALLET_URL.href);
  } catch {
    // A pre-opened window that already navigated is already on the wallet
    // origin; cross-origin location reads are expected to throw here.
  }

  const id = randomId('wallet_');
  const outbound: WalletInbound = {
    e: WALLET_CHANNEL,
    t: 'connect.request',
    request: {
      id,
      delegate: delegate.publicKey,
      surface: {
        name: request.name,
        ...(request.route ? { route: request.route } : {}),
        ...(request.context ? { context: request.context } : {}),
      },
      grant,
    },
  };

  return new Promise<WalletConnectResult>((resolve, reject) => {
    let settled = false;
    let acknowledged = false;

    const finish = (outcome: { result?: WalletConnectResult; error?: Error }) => {
      if (settled) return;
      settled = true;
      clearInterval(sendTimer);
      clearInterval(closeTimer);
      clearTimeout(handshakeTimer);
      window.removeEventListener('message', onMessage);
      if (outcome.result) resolve(outcome.result);
      else reject(outcome.error ?? new Error('hosted wallet failed'));
    };

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== popup || event.origin !== WALLET_ORIGIN || !isRecord(event.data)) return;
      if (event.data['e'] !== WALLET_CHANNEL || event.data['id'] !== id) return;

      const message = event.data as unknown as WalletOutbound;
      if (message.t === 'connect.ack') {
        acknowledged = true;
        clearInterval(sendTimer);
        clearTimeout(handshakeTimer);
        return;
      }
      if (message.t === 'connect.error') {
        finish({ error: new Error(typeof message.message === 'string' ? message.message : 'hosted wallet failed') });
        return;
      }
      if (message.t !== 'connect.result') return;

      const result = message.result;
      if (
        !result ||
        !/^[0-9a-f]{64}$/.test(result.agent) ||
        result.displayName !== 'Personal agent' ||
        !isRecord(result.delegation) ||
        'user' in result.delegation ||
        result.delegation.delegate !== delegate.publicKey ||
        result.delegation.agent !== result.agent ||
        result.delegation.origin !== location.origin ||
        // The wallet must have signed the grant we sent — a mismatch here
        // would otherwise only surface as an opaque daemon denial later.
        result.delegation.grantHash !== hashGrant(grant) ||
        // Checked here so a wallet that mints an over-long or backdated
        // authority fails visibly on this page instead of as an opaque
        // daemon denial three hops later.
        !delegationLifetimeOk(result.delegation as SessionDelegation) ||
        typeof result.delegation.sig !== 'string' ||
        !/^[0-9a-f]{128}$/.test(result.delegation.sig) ||
        typeof result.delegation.expiresAt !== 'number' ||
        !Number.isFinite(result.delegation.expiresAt) ||
        result.delegation.expiresAt <= Date.now()
      ) {
        finish({ error: new Error('hosted wallet returned an invalid delegation') });
        return;
      }
      finish({ result });
    };

    window.addEventListener('message', onMessage);
    const send = () => {
      if (settled || acknowledged) return;
      try {
        popup.postMessage(outbound, WALLET_ORIGIN);
      } catch (err) {
        log.info('wallet popup is not ready yet', { err });
      }
    };
    const sendTimer = setInterval(send, 250);
    const closeTimer = setInterval(() => {
      if (popup.closed) finish({ error: new HostedWalletUnavailable('popup_closed') });
    }, 250);
    const handshakeTimer = setTimeout(
      () => finish({ error: new HostedWalletUnavailable('handshake_timeout') }),
      POPUP_HANDSHAKE_TIMEOUT_MS,
    );
    send();
  });
}

function rememberLiveSession(
  wallet: AgentWallet,
  session: AgentSession,
  surface: string,
  clientSecretKey: string,
): void {
  const token = wallet.resumeTokenFor(session.id);
  const agentKey = wallet.agentKeyFor(session.id);
  // A mismatched caller is an implementation bug, not a record to persist:
  // the secret stored beside the token must prove the identity that opened it.
  if (publicKeyOf(clientSecretKey) !== wallet.publicKey) {
    const err = new Error('attachment identity does not match the wallet that opened the session');
    log.error('could not persist session for resume', { sessionId: session.id, err, data: { surface } });
    throw err;
  }
  if (token && agentKey) {
    rememberSession({
      id: session.id,
      agent: agentKey,
      clientSecretKey,
      token,
      relay: RELAY,
      surface,
    });
  }
  session.on('closed', () => forgetSession(surface));
}

async function connectWithHostedWallet(
  request: AgentConnectRequest,
  tools: AgentConnectRequest['tools'],
  preopened?: Window | null,
): Promise<AgentSession> {
  const delegate = generateKeyPair();
  // Built once, before approval: the wallet signs this grant's hash into the
  // delegation, so session.open must carry this exact object.
  const grant = buildGrant({
    surface: { name: request.name },
    tools,
    alwaysAsk: request.alwaysAsk,
    ttlMs: request.ttlMs,
  });
  const result = await requestHostedDelegation(request, grant, delegate, preopened);
  const wallet = new AgentWallet({ relayUrl: RELAY, userSecretKey: delegate.secretKey });
  try {
    await wallet.connect();
    const session = await wallet.openSession({
      agent: result.agent,
      approved: { delegation: result.delegation, grant },
      surface: { name: request.name, route: request.route, context: request.context },
      tools,
      decide: request.decide,
    });
    rememberLiveSession(wallet, session, request.name, delegate.secretKey);
    return session;
  } catch (err) {
    wallet.close();
    throw err;
  }
}

async function connectWithCode(
  request: AgentConnectRequest,
  tools: AgentConnectRequest['tools'],
): Promise<AgentSession> {
  // Open first, so every later failure is visible to the user.
  const modal = openConnectModal(request.name);

  const client = generateKeyPair();
  const wallet = new AgentWallet({
    relayUrl: RELAY,
    // Authority-free and scoped to this attachment. It survives only beside
    // that attachment's resume capability in this tab's sessionStorage.
    userSecretKey: client.secretKey,
  });
  try {
    await wallet.connect();
  } catch (err) {
    log.error('relay unreachable', { err, data: { relayUrl: RELAY } });
    modal.status(`could not reach the relay: ${toErr(err).message}`, true);
    throw err;
  }

  const { code, accepted } = await wallet.beginConnect({
    surface: { name: request.name, route: request.route, context: request.context },
    tools,
    alwaysAsk: request.alwaysAsk,
    ttlMs: request.ttlMs,
    // The daemon's terminal gate still decides first; the panel decider makes
    // any approval delivered to the page visible rather than auto-allowing it.
    decide: request.decide,
  });

  modal.setCode(code);
  try {
    const session = await Promise.race([accepted, modal.cancelled]);
    rememberLiveSession(wallet, session, request.name, client.secretKey);
    modal.status('connected');
    setTimeout(() => modal.close(), 400);
    return session;
  } catch (err) {
    const failure = toErr(err);
    if (!/cancelled/i.test(failure.message)) log.error('connect failed', { err, data: { relayUrl: RELAY } });
    modal.status(failure.message, true);
    setTimeout(() => modal.close(), 2200);
    wallet.close();
    throw err;
  }
}

async function connectWithoutExtension(request: AgentConnectRequest, preopened?: Window | null): Promise<AgentSession> {
  const tools = webMcp.harvest(request.tools);
  try {
    return await connectWithHostedWallet(request, tools, preopened);
  } catch (err) {
    if (!(err instanceof HostedWalletUnavailable)) throw err;
    log.info('hosted wallet unavailable; using the connect-code fallback', { data: { reason: err.reason } });
    return connectWithCode(request, tools);
  }
}

const provider: AgentProvider & {
  resume(request: AgentConnectRequest): Promise<{ session: AgentSession; missed: number } | null>;
} = {
  version: '0.0.1',

  // Never dials the relay: a page must not be able to learn anything about
  // the user before they have agreed to anything.
  async isAvailable() {
    return true;
  },

  /**
   * Re-attach after a page refresh, if this tab left a live session behind.
   * Returns null when there is nothing to resume — the caller then shows the
   * normal Connect button, so a dead token is never a dead end.
   */
  async resume(request: AgentConnectRequest): Promise<{ session: AgentSession; missed: number } | null> {
    const record = rememberedSession(request.name);
    if (!record) return null;
    const tools = webMcp.harvest(request.tools);

    const wallet = new AgentWallet({ relayUrl: RELAY, userSecretKey: record.clientSecretKey });
    try {
      await wallet.connect();
      const resumed = await wallet.resumeSession({
        id: record.id,
        agent: record.agent,
        token: record.token,
        tools,
        decide: request.decide,
      });
      resumed.session.on('closed', () => forgetSession(request.name));
      return resumed;
    } catch (err) {
      wallet.close();
      // Only a denial that PROVES the session is dead may delete the record.
      // Anything transient — a lost already_attached race, a rekey timeout, a
      // network blip — keeps the token so the next load can try again;
      // deleting it here is how a one-second race used to become a
      // permanently lost session.
      const reason = err instanceof ResumeError ? err.reason : '';
      if (reason === 'not_resumable' || reason === 'grant_expired' || reason === 'authorization_expired') {
        log.info('previous session is gone; starting fresh', {
          sessionId: record.id,
          data: { reason, surface: request.name },
        });
        forgetSession(request.name);
        return null;
      }
      log.error('resume failed; record kept for retry', {
        sessionId: record.id,
        err,
        data: { surface: request.name },
      });
      throw err instanceof Error ? err : new Error(toErr(err).message);
    }
  },

  async connect(request: AgentConnectRequest): Promise<AgentSession> {
    return connectWithoutExtension(request);
  },
};

/**
 * Provider discovery. An installed wallet wins and keeps consent in browser
 * chrome. Without one, this provider runs the hosted-wallet popup and retains
 * the code-carrying flow as the documented universal fallback.
 */
export function getProvider(): AgentProvider {
  return (navigator as unknown as { agent?: AgentProvider }).agent ?? provider;
}

type InstalledProvider = AgentProvider & {
  resume?: (request: AgentConnectRequest) => Promise<AgentSessionHandle | null>;
};

/**
 * An extension injects its provider with an async <script>, so at module time
 * `navigator.agent` may simply not exist YET — deciding on a single synchronous
 * read is how a refresh lands on the drop-in path and shows Connect for a
 * session the wallet still holds. Wait for `agent#initialized` (the NIP-07
 * idiom) with a short deadline before concluding no wallet is installed.
 */
function installedProvider(timeoutMs = 400): Promise<InstalledProvider | undefined> {
  const now = readInstalledProvider();
  if (now) return Promise.resolve(now);
  // An extension injects at document_start; once the document has fully
  // loaded, a provider that hasn't appeared never will — don't tax the
  // no-extension path with the deadline.
  if (document.readyState === 'complete') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener('agent#initialized', onReady);
      resolve(readInstalledProvider());
    }, timeoutMs);
    const onReady = () => {
      clearTimeout(timer);
      window.removeEventListener('agent#initialized', onReady);
      resolve(readInstalledProvider());
    };
    window.addEventListener('agent#initialized', onReady);
  });
}

function readInstalledProvider(): InstalledProvider | undefined {
  return (navigator as unknown as { agent?: InstalledProvider }).agent;
}

const AgentPort = {
  provider,
  getProvider,
  connect: async (request: AgentConnectRequest) => {
    const immediate = readInstalledProvider();
    if (immediate) return immediate.connect(request);

    // Reserve the popup while this call still has user activation. If the
    // extension appears during its document-start grace window, it still wins
    // and the blank reservation is closed without visiting the wallet origin.
    const popup = openWalletPopup('about:blank');
    const installed = await installedProvider();
    if (installed) {
      popup?.close();
      return installed.connect(request);
    }
    return connectWithoutExtension(request, popup);
  },
  /**
   * Resume follows the same discovery as connect: an installed wallet keeps
   * sessions alive across navigations and hands the reclaimed one back; the
   * drop-in falls back to its per-tab sessionStorage token.
   */
  resume: async (request: AgentConnectRequest) => {
    const installed = await installedProvider();
    if (installed?.resume) {
      const session = await installed.resume(request);
      return session ? { session, missed: 0 } : null;
    }
    return provider.resume(request);
  },
};

(globalThis as unknown as { AgentPort: typeof AgentPort }).AgentPort = AgentPort;

export default AgentPort;
export type { AgentConnectRequest, AgentSession, AgentSessionHandle };
