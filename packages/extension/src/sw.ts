/**
 * The wallet proper.
 *
 * Everything the page must never reach lives here: the user's Ed25519 secret
 * key, the single authenticated socket to the relay, the live sessions and
 * their grants. Content scripts are clients of this worker, not peers of it —
 * they may ask for a session and answer tool calls, and that is the whole
 * surface.
 *
 * Two stamps are applied here and never taken from a caller:
 *
 *   - the surface origin comes from `port.sender.origin`, the browser's own
 *     view of which site is asking (the local analogue of AGENTS.md invariant
 *     3: never trust a self-reported identity in a frame);
 *   - session references are minted here and scoped to the port that opened
 *     them, so a frame cannot address a session it did not open.
 */

import { AgentWallet, type AgentSession, type SiteTool } from '@agentport/client';
import { Deferred, type AgentSummary } from '@agentport/protocol';
import {
  LIMITS,
  mintId,
  sanitizeConnectRequest,
  isRecord,
  type AgentRow,
  type ContentToWorker,
  type Origin,
  type PageConnectRequest,
  type PopupToWorker,
  type WorkerToContent,
} from './bridge.js';
import { DEFAULT_RELAY_URL, ensureUserKey, importUserKey, relayUrl, setRelayUrl, userPublicKey, userSecretKey } from './storage.js';

// --- relay connection ------------------------------------------------------

let walletPromise: Promise<AgentWallet> | undefined;

async function getWallet(): Promise<AgentWallet> {
  if (walletPromise) return walletPromise;
  walletPromise = (async () => {
    const secret = await userSecretKey();
    if (!secret) throw new Error('no identity yet — open the AgentPort popup and create one');
    const wallet = new AgentWallet({
      relayUrl: await relayUrl(),
      userSecretKey: secret,
      log: (message) => console.debug('[agentport]', message),
    });
    // A dropped socket must not leave a wallet that silently never resolves.
    // Reconnect is lazy: the next request builds a fresh one.
    wallet.on('closed', () => {
      if (walletPromise) walletPromise = undefined;
      for (const entry of [...sessions.values()]) dropSession(entry, 'relay_closed');
    });
    await wallet.connect();
    return wallet;
  })().catch((err: unknown) => {
    walletPromise = undefined;
    throw err;
  });
  return walletPromise;
}

/** Chrome stops an idle MV3 worker after 30s. Socket traffic resets that timer,
 *  but a session that is merely *open* and quiet would not — so hold a port
 *  alive while any session exists. */
function keepAlive(): void {
  void chrome.storage.local.get('agentport.keepalive');
}
setInterval(() => {
  if (sessions.size > 0) keepAlive();
}, 20_000);

// --- session registry ------------------------------------------------------

interface SessionEntry {
  ref: string;
  /** Null while orphaned: the document went away but the session survives. */
  port: chrome.runtime.Port | null;
  from: Origin;
  origin: string;
  /** The surface name from the connect request — the reclaim key with origin. */
  name: string;
  session: AgentSession;
  /** Tool names the requester registered. A tool call is only ever dispatched
   *  to whoever declared it, and results are only accepted for a call we made. */
  toolNames: Set<string>;
  pending: Map<string, Deferred<{ ok: boolean; result?: unknown; error?: string }>>;
  orphanTimer?: ReturnType<typeof setTimeout>;
}

/**
 * How long an orphaned session waits for its page to come back. Navigation and
 * refresh land well inside this; a closed tab costs one grace window before
 * the daemon sees the close.
 */
const ORPHAN_GRACE_MS = 2 * 60 * 1000;

const sessions = new Map<string, SessionEntry>();
const portSessions = new WeakMap<chrome.runtime.Port, Set<string>>();
/** Outstanding UI questions, keyed by id and pinned to the port we asked. */
const uiWaiters = new Map<string, { port: chrome.runtime.Port; deferred: Deferred<unknown> }>();

function refsOf(port: chrome.runtime.Port): Set<string> {
  let set = portSessions.get(port);
  if (!set) portSessions.set(port, (set = new Set()));
  return set;
}

/** The ownership check every inbound reference goes through. */
function lookup(port: chrome.runtime.Port, ref: unknown): SessionEntry | undefined {
  if (typeof ref !== 'string') return undefined;
  const entry = sessions.get(ref);
  return entry && entry.port === port ? entry : undefined;
}

/**
 * Navigation is not a goodbye. The document died, but the wallet — and the
 * relay session it holds — did not, so the session is parked instead of
 * closed and the next document from the same origin may reclaim it (the
 * grant's surface + TTL never lapsed, so no re-consent is asked).
 */
function orphanSession(entry: SessionEntry): void {
  if (entry.port) refsOf(entry.port).delete(entry.ref);
  entry.port = null;
  entry.orphanTimer = setTimeout(() => {
    const current = sessions.get(entry.ref);
    if (current && current.port === null) dropSession(current, 'frame_closed');
  }, ORPHAN_GRACE_MS);
}

function reclaimSession(port: chrome.runtime.Port, origin: string, request: PageConnectRequest): SessionEntry | undefined {
  for (const entry of sessions.values()) {
    if (entry.port !== null) continue;
    if (entry.origin !== origin || entry.name !== request.name || entry.from !== 'page') continue;
    if (entry.session.closed || entry.session.grant.expiresAt <= Date.now()) continue;
    clearTimeout(entry.orphanTimer);
    entry.orphanTimer = undefined;
    entry.port = port;
    // The new document re-declared its tools; the dispatch allowlist follows
    // the live declaration, still bounded by the original grant on the wire.
    entry.toolNames = new Set(request.tools.map((tool) => tool.name));
    refsOf(port).add(entry.ref);
    return entry;
  }
  return undefined;
}

function dropSession(entry: SessionEntry, reason: string): void {
  sessions.delete(entry.ref);
  clearTimeout(entry.orphanTimer);
  if (entry.port) refsOf(entry.port).delete(entry.ref);
  for (const deferred of entry.pending.values()) deferred.resolve({ ok: false, error: `session closed: ${reason}` });
  entry.pending.clear();
  entry.session.close(reason);
}

function post(port: chrome.runtime.Port, message: WorkerToContent): void {
  try {
    port.postMessage(message);
  } catch {
    // The frame went away mid-flight; teardown happens on disconnect.
  }
}

/** Ask the extension's own UI a question and wait for that port's answer. */
function ask<T>(port: chrome.runtime.Port, build: (id: string) => WorkerToContent): Promise<T> {
  const id = mintId('ui_');
  const deferred = new Deferred<unknown>();
  uiWaiters.set(id, { port, deferred });
  post(port, build(id));
  return deferred.promise as Promise<T>;
}

// --- connection flow -------------------------------------------------------

function toRow(agent: AgentSummary): AgentRow {
  return { agent: agent.agent, name: agent.name, runtime: agent.runtime, location: agent.location, online: agent.online };
}

async function openSession(
  port: chrome.runtime.Port,
  from: Origin,
  request: PageConnectRequest,
): Promise<{ ref: string; info: { agentName: string; runtime: string }; grant: unknown }> {
  if (refsOf(port).size >= LIMITS.sessionsPerChannel) throw new Rejected('denied', 'too many open sessions in this tab');

  const origin = port.sender?.origin ?? port.sender?.url ?? 'unknown://';
  const wallet = await getWallet();
  const agents = await wallet.listAgents();
  if (agents.length === 0) throw new Rejected('no_agents', 'no agents paired yet');

  const rows = agents.map(toRow);
  const picked = await ask<string | null>(port, (id) => ({ t: 'ui.pick', id, agents: rows, request }));
  const chosen = agents.find((agent) => agent.agent === picked);
  if (!chosen) throw new Rejected('cancelled', 'no agent chosen');

  const consented = await ask<boolean>(port, (id) => ({ t: 'ui.consent', id, agent: toRow(chosen), request }));
  if (consented !== true) throw new Rejected('denied', 'the user declined the capability grant');

  const ref = mintId('s_');
  const tools: SiteTool[] = request.tools.map((definition) => ({
    ...definition,
    handler: (args) => dispatchToolCall(ref, definition.name, args),
  }));

  // Approvals and events must follow rebinds, so they resolve the entry's
  // CURRENT port at fire time instead of capturing this one.
  const livePort = (): chrome.runtime.Port | null => sessions.get(ref)?.port ?? port;

  // Deliberately not `createWalletProvider`: that helper builds the surface
  // descriptor without an origin, which would let the agent see the extension's
  // own origin instead of the site it was attached to. The picker/consent steps
  // above are the same flow, with the browser's origin stamped in.
  const session = await wallet.openSession({
    agent: chosen.agent,
    surface: { name: request.name, origin, route: request.route, context: request.context },
    tools,
    alwaysAsk: request.alwaysAsk,
    ttlMs: request.ttlMs,
    decide: (prompt) => {
      const target = livePort();
      // An approval that arrives while the page is navigating has nobody to
      // ask. Deny — the agent can retry once the surface is back.
      if (!target) return false;
      return ask<boolean>(target, (id) => ({
        t: 'ui.approve',
        id,
        ref,
        summary: prompt.summary,
        ...(prompt.call ? { call: prompt.call } : {}),
      })).then((granted) => granted === true);
    },
  });

  const entry: SessionEntry = {
    ref,
    port,
    from,
    origin,
    name: request.name,
    session,
    toolNames: new Set(request.tools.map((tool) => tool.name)),
    pending: new Map(),
  };
  sessions.set(ref, entry);
  refsOf(port).add(ref);

  for (const event of ['delta', 'thought', 'done', 'tool'] as const) {
    session.on(event, (payload) => {
      const target = livePort();
      if (target) post(target, { t: 'event', ref, event, payload });
    });
  }
  session.on('closed', (payload) => {
    const current = sessions.get(ref);
    sessions.delete(ref);
    clearTimeout(current?.orphanTimer);
    const target = current?.port ?? null;
    if (target) {
      refsOf(target).delete(ref);
      post(target, { t: 'event', ref, event: 'closed', payload });
    }
  });

  return {
    ref,
    info: { agentName: session.info.agentName, runtime: session.info.runtime },
    grant: { tools: session.grant.tools, expiresAt: session.grant.expiresAt },
  };
}

/** A tool call goes back to whoever registered the tool, and nowhere else. */
function dispatchToolCall(ref: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const entry = sessions.get(ref);
  if (!entry) throw new Error('session is gone');
  if (!entry.toolNames.has(name)) throw new Error(`tool ${name} is not in this grant`);
  if (entry.pending.size >= LIMITS.pendingCallsPerSession) throw new Error('too many tool calls in flight');

  if (!entry.port) throw new Error('the page is navigating; retry in a moment');

  const callId = mintId('c_');
  const deferred = new Deferred<{ ok: boolean; result?: unknown; error?: string }>();
  entry.pending.set(callId, deferred);
  post(entry.port, { t: 'tool.call', ref, callId, name, arguments: args });

  return deferred.promise.then((outcome) => {
    if (!outcome.ok) throw new Error(outcome.error ?? 'tool call failed');
    return outcome.result;
  });
}

class Rejected extends Error {
  constructor(readonly reason: string, message: string) {
    super(message);
    this.name = 'Rejected';
  }
}

// --- content script port ---------------------------------------------------

function handleContent(port: chrome.runtime.Port): void {
  port.onMessage.addListener((raw: unknown) => {
    if (!isRecord(raw)) return;
    void onContentMessage(port, raw as ContentToWorker);
  });
  port.onDisconnect.addListener(() => {
    for (const ref of [...refsOf(port)]) {
      const entry = sessions.get(ref);
      if (!entry) continue;
      // The extension's own widget sessions die with their document — only
      // page surfaces navigate and come back.
      if (entry.from === 'page') orphanSession(entry);
      else dropSession(entry, 'frame_closed');
    }
    for (const [id, waiter] of [...uiWaiters]) {
      if (waiter.port !== port) continue;
      uiWaiters.delete(id);
      waiter.deferred.resolve(null);
    }
  });
}

async function onContentMessage(port: chrome.runtime.Port, message: ContentToWorker): Promise<void> {
  switch (message.t) {
    case 'status': {
      const pubkey = await userPublicKey();
      post(port, { t: 'ok', rid: message.rid, value: { hasIdentity: Boolean(pubkey), relay: await relayUrl() } });
      return;
    }
    case 'resume': {
      const request = sanitizeConnectRequest(message.request);
      if (!request) {
        post(port, { t: 'err', rid: message.rid, reason: 'denied', message: 'malformed connect request' });
        return;
      }
      const origin = port.sender?.origin ?? port.sender?.url ?? 'unknown://';
      const entry = reclaimSession(port, origin, request);
      post(port, {
        t: 'ok',
        rid: message.rid,
        value: entry
          ? {
              ref: entry.ref,
              info: { agentName: entry.session.info.agentName, runtime: entry.session.info.runtime },
              grant: { tools: entry.session.grant.tools, expiresAt: entry.session.grant.expiresAt },
            }
          : null,
      });
      return;
    }
    case 'history': {
      const entry = lookup(port, message.ref);
      if (!entry) {
        post(port, { t: 'err', rid: message.rid, reason: 'denied', message: 'unknown session' });
        return;
      }
      entry.session.history().then(
        (entries) => post(port, { t: 'ok', rid: message.rid, value: entries }),
        (err: unknown) =>
          post(port, { t: 'err', rid: message.rid, reason: 'error', message: err instanceof Error ? err.message : String(err) }),
      );
      return;
    }
    case 'connect': {
      // The content script is trusted to say whether a request came from the
      // page or from our own widget, because it is the one that knows. It is
      // not trusted about the request's contents — re-sanitized here, after the
      // structured clone, because a compromised renderer is one bug away.
      const request = sanitizeConnectRequest(message.request);
      if (!request) {
        post(port, { t: 'err', rid: message.rid, reason: 'denied', message: 'malformed connect request' });
        return;
      }
      try {
        const value = await openSession(port, message.from === 'widget' ? 'widget' : 'page', request);
        post(port, { t: 'ok', rid: message.rid, value });
      } catch (err) {
        const reason = err instanceof Rejected ? err.reason : 'denied';
        post(port, { t: 'err', rid: message.rid, reason, message: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    case 'prompt': {
      const entry = lookup(port, message.ref);
      if (!entry) {
        post(port, { t: 'err', rid: message.rid, reason: 'denied', message: 'unknown session' });
        return;
      }
      // The prompt id the caller chose is local to it; the session mints its
      // own, and we translate on the way back out.
      entry.session
        .prompt(message.text, message.context)
        .then(
          (text) => post(port, { t: 'ok', rid: message.rid, value: text }),
          (err: unknown) =>
            post(port, { t: 'err', rid: message.rid, reason: 'error', message: err instanceof Error ? err.message : String(err) }),
        );
      return;
    }
    case 'prompt.cancel': {
      lookup(port, message.ref)?.session.cancel(message.promptId);
      return;
    }
    case 'tool.result': {
      const entry = lookup(port, message.ref);
      const deferred = entry?.pending.get(message.callId);
      if (!entry || !deferred) return; // unknown or already-answered call id
      entry.pending.delete(message.callId);
      deferred.resolve(
        message.ok ? { ok: true, result: message.result } : { ok: false, error: message.error ?? 'tool failed' },
      );
      return;
    }
    case 'ui.result': {
      const waiter = uiWaiters.get(message.id);
      if (!waiter || waiter.port !== port) return; // not this frame's question
      uiWaiters.delete(message.id);
      waiter.deferred.resolve(message.value);
      return;
    }
    case 'close': {
      const entry = lookup(port, message.ref);
      if (entry) dropSession(entry, message.reason ?? 'closed');
      return;
    }
    default:
      return;
  }
}

// --- popup port ------------------------------------------------------------

function handlePopup(port: chrome.runtime.Port): void {
  port.onMessage.addListener((raw: unknown) => {
    if (!isRecord(raw) || typeof raw['rid'] !== 'string') return;
    const rid = raw['rid'];
    void onPopupMessage(raw as unknown as PopupToWorker)
      .then((value) => port.postMessage({ t: 'ok', rid, value }))
      .catch((err: unknown) => port.postMessage({ t: 'err', rid, message: err instanceof Error ? err.message : String(err) }));
  });
}

const pairOffers = new Map<string, { code: string; agent: { pubkey: string; name: string; runtime: string; location?: string } }>();

async function onPopupMessage(message: PopupToWorker): Promise<unknown> {
  switch (message.t) {
    case 'identity':
      return { pubkey: await userPublicKey(), relay: await relayUrl(), defaultRelay: DEFAULT_RELAY_URL };
    case 'identity.create': {
      await ensureUserKey();
      walletPromise = undefined;
      return { pubkey: await userPublicKey() };
    }
    case 'identity.import': {
      await importUserKey(String(message.secretKey ?? '').trim());
      walletPromise = undefined;
      return { pubkey: await userPublicKey() };
    }
    case 'relay.set': {
      const url = await setRelayUrl(String(message.url ?? '').trim());
      walletPromise = undefined;
      return { relay: url };
    }
    case 'agents': {
      const wallet = await getWallet();
      return { agents: (await wallet.listAgents()).map(toRow) };
    }
    case 'pair.claim': {
      const wallet = await getWallet();
      const offer = await wallet.claimPairing(String(message.code ?? '').trim().toUpperCase());
      pairOffers.set(offer.code, offer);
      return offer;
    }
    case 'pair.approve': {
      const offer = pairOffers.get(String(message.code ?? ''));
      if (!offer) throw new Error('claim the pairing code first');
      const wallet = await getWallet();
      // The cert is signed here, inside the worker, from a key that never left
      // it. This is the one moment the user key is used for anything but auth.
      const cert = await wallet.approvePairing(offer, message.name ? { name: message.name } : {});
      pairOffers.delete(offer.code);
      return { cert: { agent: cert.agent, name: cert.name, runtime: cert.runtime } };
    }
    case 'sessions':
      return {
        sessions: [...sessions.values()].map((entry) => ({
          ref: entry.ref,
          origin: entry.origin,
          from: entry.from,
          agentName: entry.session.info.agentName,
          tools: [...entry.toolNames],
          expiresAt: entry.session.grant.expiresAt,
        })),
      };
    default:
      throw new Error('unknown request');
  }
}

// --- entry -----------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  // Only our own content scripts and our own popup. `externally_connectable`
  // is not declared in the manifest, so a web page cannot reach this listener
  // at all; this is belt-and-braces for the day someone adds it.
  if (port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  if (port.name === 'agentport.content' && port.sender.tab) handleContent(port);
  else if (port.name === 'agentport.popup' && !port.sender.tab) handlePopup(port);
  else port.disconnect();
});
