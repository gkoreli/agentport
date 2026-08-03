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
 *
 * Three ADR-009 properties are enforced here and nowhere weaker:
 *
 *   - consent and approvals render in an extension-origin popup window,
 *     never in page DOM or an OS notification that may be silently hidden;
 *   - what a page learns about the agent is a generic label plus a per-origin
 *     alias — real names, pubkeys and cert contents stay in extension chrome;
 *   - the page's session survives navigation and worker eviction without any
 *     re-consent, because the grant never lapsed: first by re-binding the
 *     worker-held session, then by resuming through the relay with a stored
 *     token (every resumed attachment performs a fresh mandatory handshake).
 */

import { AgentWallet, ResumeError, type AgentSession, type SiteTool } from '@agentport/client';
import { createLogger, Deferred, toErr, type AgentSummary, type LogContext, type ToolDefinition } from '@agentport/protocol';
import {
  LIMITS,
  mintId,
  sanitizeConnectRequest,
  isRecord,
  type AgentRow,
  type ConsentPayload,
  type ConsentToWorker,
  type ContentToWorker,
  type ExtensionProviderErrorReason,
  type Origin,
  type PageConnectRequest,
  type PopupToWorker,
  type WorkerToConsent,
  type WorkerToContent,
} from './bridge.js';
import { loadCerts, saveCert,
  DEFAULT_RELAY_URL,
  clearResume,
  ensureUserKey,
  importUserKey,
  loadResume,
  originAlias,
  relayUrl,
  saveResume,
  setRelayUrl,
  userPublicKey,
  userSecretKey,
} from './storage.js';
import { AGENTPORT_VERSION } from './version.js';

const log = createLogger('extension.sw');

self.addEventListener('error', (event: ErrorEvent) => {
  log.error('uncaught service-worker error', {
    err: event.error ?? event.message,
    data: { filename: event.filename, line: event.lineno, column: event.colno },
  });
});
self.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  log.error('unhandled service-worker rejection', { err: event.reason });
});

function observe(promise: PromiseLike<unknown> | undefined, message: string, context?: LogContext): void {
  if (!promise) return;
  void promise.then(undefined, (err: unknown) => log.error(message, { ...context, err }));
}

// --- relay connection ------------------------------------------------------

let walletPromise: Promise<AgentWallet> | undefined;
let redialTimer: ReturnType<typeof setTimeout> | undefined;
let redialMs = 1000;

async function getWallet(): Promise<AgentWallet> {
  if (walletPromise) return walletPromise;
  walletPromise = (async () => {
    const secret = await userSecretKey();
    if (!secret) throw new Error('no identity yet — open the AgentPort popup and create one');
    const wallet = new AgentWallet({ relayUrl: await relayUrl(), userSecretKey: secret });
    // A dropped socket is not a goodbye for the sessions it carried: the relay
    // holds them for a grace period. Redial with backoff and re-attach them.
    wallet.on('closed', () => {
      if (walletPromise) walletPromise = undefined;
      scheduleRedial();
    });
    await wallet.connect();
    return wallet;
  })().catch((err: unknown) => {
    walletPromise = undefined;
    throw err;
  });
  return walletPromise;
}

function scheduleRedial(): void {
  if (redialTimer || sessions.size === 0) return;
  const delay = redialMs;
  redialMs = Math.min(redialMs * 2, 30_000);
  redialTimer = setTimeout(() => {
    redialTimer = undefined;
    observe(reconnect(), 'relay reconnect failed');
  }, delay);
}

/** Redial the relay and re-attach every session the worker still holds. */
async function reconnect(): Promise<void> {
  if (sessions.size === 0) return;
  let wallet: AgentWallet;
  try {
    wallet = await getWallet();
  } catch (err) {
    log.warn('relay redial failed; retrying with backoff', { err, data: { delayMs: redialMs } });
    scheduleRedial();
    return;
  }
  redialMs = 1000;
  for (const entry of [...sessions.values()]) {
    if (!sessions.has(entry.ref)) continue; // dropped while we awaited
    try {
      await resumeEntry(wallet, entry);
    } catch (err) {
      const reason = err instanceof ResumeError ? err.reason : '';
      if (reason === 'not_resumable' || reason === 'grant_expired') dropSession(entry, `resume_failed:${reason}`);
      log.warn('session resume after redial failed', {
        sessionId: entry.session.id,
        err,
        data: { reason: reason || 'transient' },
      });
      // Transient failures keep the entry; the next redial or the page's own
      // resume retries with the same token.
    }
  }
}

/** Re-attach one worker-held session over a fresh socket, in place: the page
 *  keeps its ref and never notices the relay blinked. */
async function resumeEntry(wallet: AgentWallet, entry: SessionEntry): Promise<void> {
  if (!entry.token || !entry.agent) throw new ResumeError('not_resumable');
  const definitions = entry.session.grant.tools;
  const tools: SiteTool[] = definitions.map((definition) => ({
    ...definition,
    handler: (args) => dispatchToolCall(entry.ref, definition.name, args),
  }));
  const { session } = await wallet.resumeSession({
    id: entry.session.id,
    agent: entry.agent,
    token: entry.token,
    tools,
    decide: (prompt) => askApproval(entry.origin, entry.who, prompt),
  });
  const old = entry.session;
  entry.session = session;
  entry.who.name = session.info.agentName;
  wireSession(entry);
  // Prompts that were mid-flight when the socket died are answered by nobody;
  // finish the old object so they reject instead of hanging. The swap above
  // makes the 'closed' this emits a no-op in wireSession, and the old socket
  // is gone, so no frame leaves.
  old.close('socket_resumed');
}

/** Chrome stops an idle MV3 worker after 30s. Socket traffic resets that timer
 *  (Chrome 116+), but a session that is merely *open* and quiet would not — so
 *  touch storage while any session exists, and let an alarm re-wake the worker
 *  so a killed socket gets redialed even after an eviction. */
function keepAlive(): void {
  observe(chrome.storage.local.get('agentport.keepalive'), 'service-worker keepalive storage touch failed');
}
setInterval(() => {
  if (sessions.size > 0) keepAlive();
}, 20_000);

observe(chrome.alarms?.create('agentport.keepalive', { periodInMinutes: 1 }), 'failed to create keepalive alarm');
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'agentport.keepalive') return;
  keepAlive();
  if (sessions.size > 0 && !walletPromise) observe(reconnect(), 'alarm-triggered relay reconnect failed');
});

// --- session registry ------------------------------------------------------

interface SessionEntry {
  ref: string;
  /** Null while orphaned: the document went away but the session survives. */
  port: chrome.runtime.Port | null;
  from: Origin;
  origin: string;
  /** The tab the binding lives in — same-tab reclaim beats the disconnect race. */
  tabId: number | undefined;
  /** The surface name from the connect request — the reclaim key with origin. */
  name: string;
  session: AgentSession;
  /** The relay's resume token — how this session survives a socket drop. */
  token: string | undefined;
  /** The agent behind the session — resume routes by it (stateless relay). */
  agent: string | undefined;
  /** The real agent name, for extension chrome only. Mutable because a resume
   *  learns it after the decide callback was already handed out. */
  who: { name: string };
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
  const tabId = port.sender?.tab?.id;
  for (const entry of sessions.values()) {
    if (entry.origin !== origin || entry.name !== request.name || entry.from !== 'page') continue;
    if (entry.session.closed || entry.session.grant.expiresAt <= Date.now()) continue;
    // Orphaned is the ordinary case. A refresh, though, can deliver the new
    // document's resume BEFORE the old port's onDisconnect — the entry still
    // looks bound. Same tab means the old document is gone by definition, so
    // stealing the binding is safe; a different live tab is not touched.
    const sameTabRefresh = entry.port !== null && tabId !== undefined && entry.tabId === tabId && entry.port !== port;
    if (entry.port !== null && !sameTabRefresh) continue;
    if (entry.port) refsOf(entry.port).delete(entry.ref);
    clearTimeout(entry.orphanTimer);
    entry.orphanTimer = undefined;
    entry.port = port;
    entry.tabId = tabId;
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
  if (entry.from === 'page') {
    observe(clearResume(entry.origin, entry.name, entry.session.id), 'failed to clear session resume record', {
      sessionId: entry.session.id,
      data: { origin: entry.origin, surface: entry.name },
    });
  }
}

function post(port: chrome.runtime.Port, message: WorkerToContent): void {
  try {
    port.postMessage(message);
  } catch {
    // The frame went away mid-flight; teardown happens on disconnect.
  }
}

// --- extension-chrome consent (ADR-009) ------------------------------------
//
// The question and the answer never touch page DOM. A pending question is a
// payload the consent window fetches by id and answers over its own port; a
// Every per-call approval uses the same extension-origin window. OS
// notifications are not a decision surface: platforms may suppress them
// after Chrome reports successful creation, leaving the tool call unanswered.

interface PendingUi {
  id: string;
  payload: ConsentPayload;
  deferred: Deferred<unknown>;
  windowId?: number;
}

const pendingUi = new Map<string, PendingUi>();

function settleUi(id: string, value: unknown): void {
  const pending = pendingUi.get(id);
  if (!pending) return;
  pendingUi.delete(id);
  pending.deferred.resolve(value);
  if (pending.windowId !== undefined) {
    observe(chrome.windows.remove(pending.windowId), 'failed to close consent window', { data: { pendingId: id } });
  }
}

async function openUiWindow(pending: PendingUi): Promise<void> {
  try {
    const win = await chrome.windows.create({
      url: chrome.runtime.getURL(`consent.html#${pending.id}`),
      type: 'popup',
      width: 400,
      height: 620,
      focused: true,
    });
    pending.windowId = win.id;
  } catch (err) {
    log.error('could not open consent window; denying request', {
      err,
      data: { pendingId: pending.id, kind: pending.payload.kind },
    });
    // No window means no consent surface, and a missing answer is a denial.
    settleUi(pending.id, pending.payload.kind === 'connect' ? null : false);
  }
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const pending of [...pendingUi.values()]) {
    if (pending.windowId !== windowId) continue;
    // Closing the window without answering is a denial, never a default grant.
    settleUi(pending.id, pending.payload.kind === 'connect' ? null : false);
  }
});

/** The connect consent: verified origin, agent picker, tool list. Resolves
 *  with the chosen agent's pubkey, or null for a decline. */
function askConnect(origin: string, agents: AgentRow[], request: PageConnectRequest): Promise<string | null> {
  const pending: PendingUi = {
    id: mintId('ui_'),
    payload: { kind: 'connect', origin, request, agents },
    deferred: new Deferred<unknown>(),
  };
  pendingUi.set(pending.id, pending);
  observe(openUiWindow(pending), 'connect consent window flow failed', { data: { pendingId: pending.id } });
  return pending.deferred.promise.then((value) => (typeof value === 'string' ? value : null));
}

function askPair(agent: { name: string; runtime: string; location?: string }): Promise<boolean> {
  const pending: PendingUi = {
    id: mintId('ui_'),
    payload: { kind: 'pair', agent },
    deferred: new Deferred<unknown>(),
  };
  pendingUi.set(pending.id, pending);
  observe(openUiWindow(pending), 'pairing consent window flow failed', { data: { pendingId: pending.id } });
  return pending.deferred.promise.then((value) => value === true);
}

/** A per-call approval in extension chrome. Never the page or OS chrome. */
function askApproval(
  origin: string,
  who: { name: string },
  prompt: { summary: string; call?: { name: string; arguments: Record<string, unknown> } },
): Promise<boolean> {
  const pending: PendingUi = {
    id: mintId('ui_'),
    payload: {
      kind: 'approve',
      origin,
      agentName: who.name,
      summary: prompt.summary,
      ...(prompt.call ? { call: prompt.call } : {}),
    },
    deferred: new Deferred<unknown>(),
  };
  pendingUi.set(pending.id, pending);
  observe(openUiWindow(pending), 'approval consent window flow failed', { data: { pendingId: pending.id } });

  return pending.deferred.promise.then((value) => value === true);
}

function handleConsent(port: chrome.runtime.Port): void {
  const reply = (message: WorkerToConsent) => {
    try {
      port.postMessage(message);
    } catch {
      // window already gone
    }
  };
  port.onMessage.addListener((raw: unknown) => {
    if (!isRecord(raw)) return;
    const message = raw as ConsentToWorker;
    if (message.t === 'consent.get') {
      const pending = typeof message.id === 'string' ? pendingUi.get(message.id) : undefined;
      if (pending) reply({ t: 'ok', rid: message.rid, value: pending.payload });
      else reply({ t: 'err', rid: message.rid, message: 'nothing to decide — this question was already answered' });
      return;
    }
    if (message.t === 'consent.answer' && typeof message.id === 'string') {
      settleUi(message.id, message.value);
    }
  });
}

// --- connection flow -------------------------------------------------------

function toRow(agent: AgentSummary): AgentRow {
  return { agent: agent.agent, name: agent.name, runtime: agent.runtime, location: agent.location, online: agent.online };
}

/**
 * What a PAGE may learn about the session (ADR-009): a generic label and a
 * per-origin alias. The real agent name, runtime, pubkey and cert contents
 * render only in extension chrome. The widget renders in an extension-origin
 * iframe behind the content script's closed shadow root, so it keeps the real
 * name without exposing it to the page.
 */
async function infoFor(entry: SessionEntry): Promise<{ agentName: string; runtime: string; alias?: string }> {
  if (entry.from !== 'page') return { agentName: entry.session.info.agentName, runtime: entry.session.info.runtime };
  return { agentName: 'Personal agent', runtime: 'agent', alias: await originAlias(entry.origin) };
}

function grantFor(entry: SessionEntry): { tools: ToolDefinition[]; alwaysAsk: string[]; expiresAt: number } {
  return {
    tools: entry.session.grant.tools,
    alwaysAsk: entry.session.grant.alwaysAsk,
    expiresAt: entry.session.grant.expiresAt,
  };
}

/** Streaming events and teardown follow the entry's CURRENT port and CURRENT
 *  session object — rebinds and socket-level resumes both re-run this. */
function wireSession(entry: SessionEntry): void {
  const { ref, session } = entry;
  const livePort = (): chrome.runtime.Port | null => sessions.get(ref)?.port ?? null;
  for (const event of ['delta', 'thought', 'done', 'tool'] as const) {
    session.on(event, (payload) => {
      const target = livePort();
      if (target) post(target, { t: 'event', ref, event, payload });
    });
  }
  session.on('closed', (payload) => {
    const current = sessions.get(ref);
    // A socket-level resume swapped the session object; the old one going
    // quiet must not tear down its replacement.
    if (current && current.session !== session) return;
    sessions.delete(ref);
    clearTimeout(current?.orphanTimer);
    if (current?.from === 'page') {
      observe(clearResume(current.origin, current.name, session.id), 'failed to clear closed-session resume record', {
        sessionId: session.id,
        data: { origin: current.origin, surface: current.name },
      });
    }
    const target = current?.port ?? null;
    if (target) {
      refsOf(target).delete(ref);
      post(target, { t: 'event', ref, event: 'closed', payload });
    }
  });
}

async function openSession(
  port: chrome.runtime.Port,
  from: Origin,
  request: PageConnectRequest,
): Promise<{ ref: string; info: unknown; grant: unknown }> {
  if (refsOf(port).size >= LIMITS.sessionsPerChannel) throw new Rejected('denied', 'too many open sessions in this tab');

  const origin = port.sender?.origin ?? port.sender?.url ?? 'unknown://';
  const wallet = await getWallet();
  const agents = await wallet.listAgents();
  if (agents.length === 0) throw new Rejected('no_agents', 'no agents paired yet');

  // Picker + consent are ONE extension-chrome window: verified origin, agent
  // rows, the tools with gated ones marked, Approve/Decline.
  const picked = await askConnect(origin, agents.map(toRow), request);
  const chosen = agents.find((agent) => agent.agent === picked);
  if (!chosen) throw new Rejected('cancelled', 'the user declined the connection');

  const ref = mintId('s_');
  const who = { name: chosen.name };
  const tools: SiteTool[] = request.tools.map((definition) => ({
    ...definition,
    handler: (args) => dispatchToolCall(ref, definition.name, args),
  }));

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
    // Approvals go to extension chrome. The decision window is independent of
    // page DOM and closing it without answering fails shut.
    decide: (prompt) => askApproval(origin, who, prompt),
  });

  const entry: SessionEntry = {
    ref,
    port,
    from,
    origin,
    tabId: port.sender?.tab?.id,
    name: request.name,
    session,
    token: wallet.resumeTokenFor(session.id),
    agent: wallet.agentKeyFor(session.id),
    who,
    toolNames: new Set(request.tools.map((tool) => tool.name)),
    pending: new Map(),
  };
  sessions.set(ref, entry);
  refsOf(port).add(ref);
  wireSession(entry);

  // Page sessions outlive the worker: persist the resume record so a restarted
  // worker can re-attach through the relay without any new consent.
  const agentKey = wallet.agentKeyFor(session.id);
  if (from === 'page' && entry.token && agentKey) {
    observe(
      saveResume({
        id: session.id,
        agent: agentKey,
        token: entry.token,
        origin,
        name: request.name,
        expiresAt: session.grant.expiresAt,
      }),
      'failed to persist session resume record',
      { sessionId: session.id, data: { origin, surface: request.name } },
    );
  }

  return { ref, info: await infoFor(entry), grant: grantFor(entry) };
}

/**
 * The fallback behind `reclaimSession`: the worker restarted and lost its
 * table, but the relay still holds the session and storage still holds the
 * token. Resume it, re-bind it to this page, and hand back the same generic
 * info a fresh connect would have — no picker, no consent, because the grant
 * the user approved never lapsed.
 */
async function resumeFromStore(
  port: chrome.runtime.Port,
  origin: string,
  request: PageConnectRequest,
): Promise<SessionEntry | undefined> {
  const record = await loadResume(origin, request.name);
  if (!record) return undefined;
  if (record.expiresAt <= Date.now()) {
    observe(clearResume(origin, request.name, record.id), 'failed to clear expired resume record', {
      sessionId: record.id,
      data: { origin, surface: request.name },
    });
    return undefined;
  }
  // A live entry bound to another tab already owns this session; the relay
  // would refuse anyway (already_attached), so do not even race it.
  for (const entry of sessions.values()) {
    if (entry.origin === origin && entry.name === request.name && entry.from === 'page') return undefined;
  }

  const wallet = await getWallet();
  const ref = mintId('s_');
  const who = { name: 'your agent' };
  const tools: SiteTool[] = request.tools.map((definition) => ({
    ...definition,
    handler: (args) => dispatchToolCall(ref, definition.name, args),
  }));

  try {
    const { session } = await wallet.resumeSession({
      id: record.id,
      agent: record.agent,
      token: record.token,
      tools,
      decide: (prompt) => askApproval(origin, who, prompt),
    });
    who.name = session.info.agentName;
    const entry: SessionEntry = {
      ref,
      port,
      from: 'page',
      origin,
      tabId: port.sender?.tab?.id,
      name: request.name,
      session,
      token: record.token,
      agent: record.agent,
      who,
      toolNames: new Set(request.tools.map((tool) => tool.name)),
      pending: new Map(),
    };
    sessions.set(ref, entry);
    refsOf(port).add(ref);
    wireSession(entry);
    return entry;
  } catch (err) {
    const reason = err instanceof ResumeError ? err.reason : '';
    if (reason === 'not_resumable' || reason === 'grant_expired') {
      // Proven dead. Anything else is transient — keep the token for retry.
      observe(clearResume(origin, request.name, record.id), 'failed to clear dead resume record', {
        sessionId: record.id,
        data: { origin, surface: request.name },
      });
    }
    log.warn('stored session resume failed', {
      sessionId: record.id,
      err,
      data: { origin, surface: request.name, reason: reason || 'transient' },
    });
    return undefined;
  }
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
  constructor(readonly reason: ExtensionProviderErrorReason, message: string) {
    super(message);
    this.name = 'Rejected';
  }
}

// --- content script port ---------------------------------------------------

type ContentRequest = Exclude<ContentToWorker, { t: 'hello' }>;

function handleContent(port: chrome.runtime.Port): void {
  let contentVersion: string | undefined;
  port.onMessage.addListener((raw: unknown) => {
    if (!isRecord(raw)) return;
    const message = raw as ContentToWorker;
    if (message.t === 'hello') {
      contentVersion = typeof message.version === 'string' ? message.version : '';
      const compatible = contentVersion === AGENTPORT_VERSION;
      if (!compatible) {
        log.warn('extension build mismatch during content handshake', {
          data: { contentVersion, workerVersion: AGENTPORT_VERSION, origin: port.sender?.origin },
        });
      }
      post(port, { t: 'hello', version: AGENTPORT_VERSION, compatible });
      return;
    }
    if (contentVersion !== AGENTPORT_VERSION) {
      log.warn('content request refused while extension is updating', {
        data: {
          contentVersion: contentVersion ?? 'missing',
          workerVersion: AGENTPORT_VERSION,
          messageType: message.t,
          origin: port.sender?.origin,
        },
      });
      if ('rid' in message) {
        post(port, {
          t: 'err',
          rid: message.rid,
          reason: 'extension_updating',
          message: 'AgentPort is updating; retry with another provider',
        });
      }
      return;
    }
    void onContentMessage(port, message as ContentRequest).catch((err: unknown) => {
      log.error('content message handler failed', { err, data: { messageType: message.t } });
      if ('rid' in message) {
        post(port, { t: 'err', rid: message.rid, reason: 'error', message: toErr(err).message });
      }
    });
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
  });
}

async function onContentMessage(port: chrome.runtime.Port, message: ContentRequest): Promise<void> {
  switch (message.t) {
    case 'pair.link': {
      const senderUrl = port.sender?.url;
      const configuredRelay = new URL(await relayUrl());
      configuredRelay.protocol = configuredRelay.protocol === 'wss:' ? 'https:' : 'http:';
      const sender = senderUrl ? new URL(senderUrl) : undefined;
      if (!sender || sender.origin !== configuredRelay.origin || sender.pathname !== '/pair') {
        post(port, { t: 'err', rid: message.rid, reason: 'denied', message: 'pairing links are only accepted from your configured AgentPort host' });
        return;
      }
      const code = message.code.trim().toUpperCase();
      if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code)) {
        post(port, { t: 'err', rid: message.rid, reason: 'denied', message: 'invalid pairing code' });
        return;
      }
      const wallet = await getWallet();
      const offer = await wallet.claimPairing(code);
      const approved = await askPair(offer.agent);
      if (!approved) {
        post(port, { t: 'err', rid: message.rid, reason: 'cancelled', message: 'pairing declined' });
        return;
      }
      const cert = await wallet.approvePairing(offer);
      await saveCert({ agent: cert.agent, name: cert.name, runtime: cert.runtime, location: cert.location });
      post(port, { t: 'ok', rid: message.rid, value: { agent: { name: cert.name } } });
      return;
    }
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
      // Worker-held first (nothing crossed the network); relay-token second.
      let entry = reclaimSession(port, origin, request);
      if (!entry) entry = await resumeFromStore(port, origin, request);
      post(port, {
        t: 'ok',
        rid: message.rid,
        value: entry ? { ref: entry.ref, info: await infoFor(entry), grant: grantFor(entry) } : null,
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
        (err: unknown) => {
          log.error('session history request failed', { sessionId: entry.session.id, err });
          post(port, { t: 'err', rid: message.rid, reason: 'error', message: toErr(err).message });
        },
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
        log.error('session connect request failed', {
          err,
          data: { origin: port.sender?.origin, surface: request.name, reason },
        });
        post(port, { t: 'err', rid: message.rid, reason, message: toErr(err).message });
      }
      return;
    }
    case 'prompt': {
      const entry = lookup(port, message.ref);
      if (!entry) {
        post(port, { t: 'err', rid: message.rid, reason: 'denied', message: 'unknown session' });
        return;
      }
      // The page minted the prompt id; run the turn under it so every event
      // the page sees already carries the id it knows.
      const request = entry.session.startPrompt(message.text, message.context, message.promptId);
      request.result.then(
          (text) => post(port, { t: 'ok', rid: message.rid, value: text }),
          (err: unknown) => {
            log.error('session prompt failed', { sessionId: entry.session.id, err });
            post(port, { t: 'err', rid: message.rid, reason: 'error', message: toErr(err).message });
          },
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
    const reply = (message: unknown) => {
      try {
        port.postMessage(message);
      } catch {
        // The popup was closed; there is no remaining user-visible surface to update.
      }
    };
    void onPopupMessage(raw as unknown as PopupToWorker)
      .then((value) => reply({ t: 'ok', rid, value }))
      .catch((err: unknown) => {
        log.error('popup request failed', { err, data: { messageType: raw['t'] } });
        reply({ t: 'err', rid, message: toErr(err).message });
      });
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
      // Durable list from our own cert store; liveness from the relay.
      const wallet = await getWallet();
      const [owned, live] = await Promise.all([loadCerts(), wallet.listAgents()]);
      const online = new Set(live.map((agent) => agent.agent));
      const rows = owned.map((cert) => ({ ...cert, online: online.has(cert.agent) }));
      for (const agent of live) {
        if (!rows.some((row) => row.agent === agent.agent)) rows.push(toRow(agent));
      }
      return { agents: rows };
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
      // The wallet is the durable directory (ADR-016): the stateless relay
      // will only ever report live agents, so remember what we own here.
      await saveCert({ agent: cert.agent, name: cert.name, runtime: cert.runtime, location: cert.location });
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
  // Only our own content scripts, our own popup, and our own consent window.
  // `externally_connectable` is not declared in the manifest, so a web page
  // cannot reach this listener at all; this is belt-and-braces for the day
  // someone adds it.
  if (port.sender?.id !== chrome.runtime.id) {
    port.disconnect();
    return;
  }
  if (port.name === 'agentport.content' && port.sender.tab) handleContent(port);
  else if (port.name === 'agentport.popup' && !port.sender.tab) handlePopup(port);
  else if (port.name === 'agentport.consent' && port.sender.url?.startsWith(chrome.runtime.getURL('consent.html')))
    handleConsent(port);
  else port.disconnect();
});
