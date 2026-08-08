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
 *   - a session survives navigation and worker eviction without any
 *     re-consent, because the grant never lapsed: first by re-binding the
 *     worker-held session, then by resuming through the relay with a stored
 *     token (every resumed attachment performs a fresh mandatory handshake).
 *
 * There is ONE lifecycle for that last property. A page-declared surface and
 * the extension's own widget park and reclaim by the same rules; what differs
 * is only the identity they are reclaimed by, computed once in `lifecycle.ts`.
 * Crossing an origin is not a navigation the attachment follows: the origin is
 * the unit of consent, so a top-level document arriving on a different origin
 * closes what the tab was holding instead of parking it.
 */

import { AgentWallet, ResumeError, type AgentSession, type SiteTool } from '@agentport/client';
import {
  createLogger,
  Deferred,
  toErr,
  type AgentSummary,
  type LogContext,
  type PlanStep,
  type ToolDefinition,
  type AuthorityDomain,
} from '@agentport/protocol';
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
import { leftBehindByNavigation, mayReclaim, reclaimKeyFor, synthesisedNames } from './lifecycle.js';
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

async function getWallet(): Promise<AgentWallet> {
  if (walletPromise) return walletPromise;
  walletPromise = (async () => {
    const secret = await userSecretKey();
    if (!secret) throw new Error('no identity yet — open the AgentPort popup and create one');
    const wallet = new AgentWallet({ relayUrl: await relayUrl(), userSecretKey: secret });
    // Reconnection belongs to the wallet, and only to the wallet. A dropped
    // socket is not a goodbye for the sessions it carried, so the wallet
    // redials with backoff and re-resumes each live session IN PLACE — the
    // same AgentSession object, rekeyed. That is what makes a second loop here
    // unnecessary rather than merely redundant: `entry.session` keeps pointing
    // at the live attachment, the tool handlers bound to it at connect time
    // are still the ones it will call, and every listener `wireSession`
    // registered still fires. Nothing in this table needs rebuilding.
    //
    // A redial loop here would also race the wallet's for the same session id,
    // and the relay refuses the loser with `already_attached`.
    //
    // So 'closed' does not mean "retry": the wallet emits it only when there
    // was nothing to preserve, or when it has exhausted its attempts and
    // already told each session it was dropped. Both are terminal for this
    // wallet object, so let go of it and let the next caller dial a fresh one.
    wallet.on('closed', () => {
      if (walletPromise) walletPromise = undefined;
      log.warn('relay wallet closed; the next request will dial a fresh one', {
        data: { sessions: sessions.size },
      });
    });
    await wallet.connect();
    return wallet;
  })().catch((err: unknown) => {
    walletPromise = undefined;
    throw err;
  });
  return walletPromise;
}

/**
 * Chrome stops an idle MV3 worker after 30s. Socket traffic resets that timer
 * (Chrome 116+), but a session that is merely *open* and quiet would not — so
 * touch storage while any session exists, which keeps alive the worker, its
 * socket, and the wallet's own redial timers along with them.
 *
 * Waking the worker is all this can do. An eviction takes the session table
 * with it — it is in memory deliberately, because the transcript is the
 * user's — so a woken worker has no attachment left to redial FOR. Recovering
 * from an eviction is `resumeFromStore`, driven by the next document that
 * connects carrying a matching resume record.
 */
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
  /** 0 for a tab's top-level document. Only top-frame entries are evicted by a
   *  cross-origin navigation, and only a top-frame arrival evicts. */
  frameId: number | undefined;
  /** The surface name from the connect request. Page-supplied: for logs and the
   *  consent card, never for addressing — see `reclaimKey`. */
  name: string;
  /**
   * The one identity a parked session is reclaimed by, in the worker's table
   * and in the durable resume record alike. Null means this surface cannot
   * outlive its document and is closed on disconnect.
   */
  reclaimKey: string | null;
  session: AgentSession;
  /** The relay's resume token, for the durable record only: a socket drop is
   *  the wallet's to recover, and it holds this token itself. What survives the
   *  WORKER is `saveResume`, which is why the token is still kept here. */
  token: string | undefined;
  /** The real agent name, for extension chrome only. Mutable because a resume
   *  learns it after the decide callback was already handed out. */
  who: { name: string };
  /** Tool names the requester registered. A tool call is only ever dispatched
   *  to whoever declared it, and results are only accepted for a call we made. */
  toolNames: Set<string>;
  pending: Map<string, Deferred<{ ok: boolean; result?: unknown; error?: string }>>;
  /** Prompt ids the agent is still working on. A document that reclaims this
   *  session mid-turn needs them to render a running turn instead of idle. */
  activePrompts: Set<string>;
  /** Tool calls that arrived while the document was away, waiting for the next
   *  one to bind. Settled by `reclaimSession` or by `dropSession`. */
  parked: Set<(outcome: { port: chrome.runtime.Port } | { error: string }) => void>;
  /** Agent events dropped because no document was bound. Counted, never
   *  buffered: the transcript is the user's, and the agent's own store is
   *  where a reclaiming document re-reads it from. */
  missedEvents: number;
  /**
   * The agent's CURRENT plan for the turn it is running, or undefined when it
   * has none. Held here and nowhere else because the worker is the only thing
   * that survives a navigation, and a plan is precisely the progress UI a
   * multi-page flow needs after the click that moved the page. It is state, not
   * transcript: one snapshot replaces the last, and it is dropped when the turn
   * it belongs to ends — so this can never grow, and nothing about a finished
   * conversation is retained here.
   */
  plan?: { promptId: string; steps: PlanStep[] };
  orphanTimer?: ReturnType<typeof setTimeout>;
}

/**
 * How long an orphaned session waits for its page to come back. Navigation and
 * refresh land well inside this. A cross-origin navigation no longer waits at
 * all (see `noteDocument`), so what remains on this clock is a closed tab or a
 * destination with no content script — chrome://, the PDF viewer, a download.
 */
const ORPHAN_GRACE_MS = 2 * 60 * 1000;

/**
 * How long a tool call waits for the next document to bind before failing.
 * The agent clicks a link and immediately reads the page it landed on; that
 * call must wait for the navigation rather than error out mid-turn. It must
 * also not wait for the whole orphan grace: the daemon has no tool-call
 * timeout, so an unanswerable call blocks the agent's turn.
 */
const NAV_SETTLE_MS = 10_000;

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
 *
 * The calls that were in flight ARE a goodbye, though: the document that would
 * have answered them is gone, the daemon has no tool-call timeout, and a
 * deferred nobody can settle blocks the agent's turn for the whole grace
 * window. Fail them now and let the agent try again against the new document.
 */
function orphanSession(entry: SessionEntry): void {
  if (entry.port) refsOf(entry.port).delete(entry.ref);
  entry.port = null;
  const abandoned = entry.pending.size;
  for (const deferred of entry.pending.values()) {
    deferred.resolve({ ok: false, error: 'the page navigated before this call completed' });
  }
  entry.pending.clear();
  log.info('session parked while its document navigates', {
    sessionId: entry.session.id,
    data: { origin: entry.origin, surface: entry.name, abandonedCalls: abandoned, graceMs: ORPHAN_GRACE_MS },
  });
  entry.orphanTimer = setTimeout(() => {
    const current = sessions.get(entry.ref);
    if (current && current.port === null) dropSession(current, 'frame_closed');
  }, ORPHAN_GRACE_MS);
}

/**
 * Hand a parked session to the document that just announced itself.
 *
 * `key` and `origin` both come from the browser's own stamp on the connecting
 * port — never from anything the page said — so a link to another site cannot
 * pick up an attachment the user approved for this one.
 */
function reclaimSession(
  port: chrome.runtime.Port,
  origin: string,
  key: string | null,
  request: PageConnectRequest,
): SessionEntry | undefined {
  if (!key) return undefined;
  const tabId = port.sender?.tab?.id;
  const now = Date.now();
  for (const entry of sessions.values()) {
    if (!mayReclaim(
      { reclaimKey: entry.reclaimKey, origin: entry.origin, closed: entry.session.closed, expiresAt: entry.session.grant.expiresAt },
      { key, origin, now },
    )) continue;
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
    entry.frameId = port.sender?.frameId;
    // The new document re-declared its tools; the dispatch allowlist follows
    // the live declaration, still bounded by the original grant on the wire.
    entry.toolNames = new Set(request.tools.map((tool) => tool.name));
    refsOf(port).add(entry.ref);
    if (entry.missedEvents > 0) {
      // Not a silent loss: the reclaiming document re-reads the conversation
      // from the agent's own store, and this says how much it has to recover.
      log.info('agent events arrived while no document was bound', {
        sessionId: entry.session.id,
        data: { origin: entry.origin, missedEvents: entry.missedEvents },
      });
      entry.missedEvents = 0;
    }
    for (const settle of [...entry.parked]) settle({ port });
    entry.parked.clear();
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
  for (const settle of [...entry.parked]) settle({ error: `session closed: ${reason}` });
  entry.parked.clear();
  entry.session.close(reason);
  if (entry.reclaimKey) {
    observe(clearResume(entry.origin, entry.reclaimKey, entry.session.id), 'failed to clear session resume record', {
      sessionId: entry.session.id,
      data: { origin: entry.origin, surface: entry.name },
    });
  }
}

/** The browser's own view of which site is asking. Never taken from a frame. */
function originOf(port: chrome.runtime.Port): string {
  return port.sender?.origin ?? port.sender?.url ?? 'unknown://';
}

/**
 * A top-level document announced itself. Anything this tab still holds for a
 * DIFFERENT origin belongs to a page the user has navigated away from, so it
 * is closed — a real `session.close` on the wire, which ends the agent-side
 * session and withdraws its MCP bridge — rather than parked for the grace
 * window. The attachment does not follow a link off the origin the user
 * approved it for.
 *
 * This is the only navigation signal the extension has without the `tabs` or
 * `webNavigation` permission, and it costs nothing: the content script runs at
 * document_start on every http(s) page and opens this port immediately. A
 * destination with no content script — chrome://, the PDF viewer, a download,
 * or a closed tab — still falls back to the orphan timer.
 */
function noteDocument(port: chrome.runtime.Port): void {
  const arriving = { origin: originOf(port), tabId: port.sender?.tab?.id, frameId: port.sender?.frameId };
  if (arriving.frameId !== 0) return;
  for (const entry of [...sessions.values()]) {
    if (!leftBehindByNavigation({ origin: entry.origin, tabId: entry.tabId, frameId: entry.frameId }, arriving)) continue;
    log.info('detaching a session the tab navigated away from', {
      sessionId: entry.session.id,
      data: { from: entry.origin, to: arriving.origin, surface: entry.name },
    });
    dropSession(entry, 'navigated_away');
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
  prompt: { domain: AuthorityDomain; summary: string; call?: { name: string; arguments: Record<string, unknown> } },
  synthesised: ReadonlySet<string>,
): Promise<boolean> {
  // The extension stamps this one, because the extension is the only party
  // that knows. The client sees a tool in a grant and calls it `site_tool`;
  // it cannot tell a tool the SITE declared from one WE synthesised over a
  // page that declared nothing. Same rule as ADR-023 R2 — the side that knows
  // the truth decides — applied one hop further out.
  //
  // This is a DISPLAY correction, not a routing one. A generic page tool
  // routes exactly as a site tool does, because a page can already click its
  // own buttons; what was wrong is telling the user a site lent a capability
  // the site has never heard of.
  const domain: AuthorityDomain =
    prompt.domain === 'site_tool' && prompt.call && synthesised.has(prompt.call.name)
      ? 'generic_page_tool'
      : prompt.domain;
  const pending: PendingUi = {
    id: mintId('ui_'),
    payload: {
      kind: 'approve',
      origin,
      agentName: who.name,
      domain,
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
async function infoFor(
  entry: SessionEntry,
): Promise<{ agentName: string; runtime: string; ownTools: boolean; alias?: string; verify?: string }> {
  // `ownTools` crosses to the PAGE in both branches, unlike the agent's real
  // name or its fingerprint words. It is not a fact about the attachment's
  // identity or keys, which is what ADR-009 withholds — it is a fact about
  // what the agent may do here, which the page has to render or the user is
  // left inferring a withheld capability from a guess (ADR-024 R4). Passing
  // it through is also what stops the panel claiming a restriction that does
  // not apply: an extension attachment KEEPS its own tools, and a page told
  // nothing would fail closed and say the opposite.
  const { ownTools } = entry.session.info;
  if (entry.from !== 'page') {
    const { agentName, runtime, verify } = entry.session.info;
    // The fingerprint words for THIS attachment, and only for the widget. The
    // widget renders in an extension-origin frame, where comparing them against
    // the daemon's consent screen actually proves something. A page could not
    // verify anything with them — it would only gain the text needed to paint a
    // convincing fake of our chrome, so the ADR-009 rule that a page learns a
    // generic label and nothing about the attachment's keys holds here too.
    return { agentName, runtime, ownTools, ...(verify ? { verify } : {}) };
  }
  return {
    agentName: 'Personal agent',
    runtime: 'agent',
    ownTools,
    alias: await originAlias(entry.origin),
  };
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

  /**
   * Send to whatever document is bound right now.
   *
   * `countIfUnbound` separates the two kinds of thing an agent emits. Turn
   * OUTPUT that nobody was holding is gone — the relay counts dropped frames
   * rather than buffering them (ADR-005) — so it is counted here and re-read
   * from the agent's own store. Attachment STATE is not lost by the same drop:
   * the worker keeps the current value and hands it to the next document, so
   * counting it would overstate what has to be recovered.
   */
  const forward = (event: string, payload: unknown, countIfUnbound: boolean): void => {
    const target = livePort();
    if (target) {
      post(target, { t: 'event', ref, event, payload });
      return;
    }
    if (!countIfUnbound) return;
    const current = sessions.get(ref);
    if (current) current.missedEvents += 1;
  };

  // `ask` is turn content, so it counts as missed when nobody is bound: a
  // question the agent asked into a document that navigated away is lost, and
  // the daemon's own deadline decays it to a skip. Counting it is how the next
  // document learns something happened it did not see.
  for (const event of ['delta', 'thought', 'tool', 'ask'] as const) {
    session.on(event, (payload) => forward(event, payload, true));
  }
  session.on('done', (payload) => {
    // A plan is what the agent intends NOW. Once its turn is over the checklist
    // is history, so the worker stops offering it to the next document rather
    // than letting a finished plan reappear after a navigation.
    const current = sessions.get(ref);
    if (current?.plan?.promptId === payload.promptId) current.plan = undefined;
    forward('done', payload, true);
  });
  session.on('plan', (payload) => {
    // Snapshot semantics (see `Plan` in messages.ts): each event REPLACES the
    // previous plan, so only the latest is worth keeping and a superseded one
    // was never lost.
    const current = sessions.get(ref);
    if (current) current.plan = { promptId: payload.promptId, steps: payload.steps };
    forward('plan', payload, false);
  });
  session.on('reattached', (payload) => {
    // The socket dropped and the wallet put this attachment back on a fresh
    // one. The turn that was in flight lost its answer (the client rejects it),
    // so whatever plan it had is stale.
    const current = sessions.get(ref);
    if (current) current.plan = undefined;
    // The fingerprint words go to the widget only, for the reason `infoFor`
    // gives: a page cannot verify with them and could fake chrome with them. A
    // page surface is still told it reattached — its in-flight prompt died and
    // it has to re-read history — just not with the attachment's key material.
    forward('reattached', current?.from === 'widget' ? payload : {}, false);
  });
  session.on('closed', (payload) => {
    const current = sessions.get(ref);
    // A socket-level resume swapped the session object; the old one going
    // quiet must not tear down its replacement.
    if (current && current.session !== session) return;
    sessions.delete(ref);
    clearTimeout(current?.orphanTimer);
    if (current) {
      for (const settle of [...current.parked]) settle({ error: 'session closed' });
      current.parked.clear();
    }
    if (current?.reclaimKey) {
      observe(clearResume(current.origin, current.reclaimKey, session.id), 'failed to clear closed-session resume record', {
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

  const origin = originOf(port);
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
    decide: (prompt) => askApproval(origin, who, prompt, synthesisedNames(request)),
  });

  const entry: SessionEntry = {
    ref,
    port,
    from,
    origin,
    tabId: port.sender?.tab?.id,
    frameId: port.sender?.frameId,
    name: request.name,
    reclaimKey: reclaimKeyFor({
      from,
      origin,
      name: request.name,
      tabId: port.sender?.tab?.id,
      toolSource: request.context?.['source'],
    }),
    session,
    token: wallet.resumeTokenFor(session.id),
    who,
    toolNames: new Set(request.tools.map((tool) => tool.name)),
    pending: new Map(),
    activePrompts: new Set(),
    parked: new Set(),
    missedEvents: 0,
  };
  sessions.set(ref, entry);
  refsOf(port).add(ref);
  wireSession(entry);

  // A reclaimable session outlives the worker too: persist the resume record,
  // under the same key the in-memory table uses, so a restarted worker can
  // re-attach through the relay without any new consent.
  const agentKey = wallet.agentKeyFor(session.id);
  if (entry.reclaimKey && entry.token && agentKey) {
    observe(
      saveResume({
        id: session.id,
        agent: agentKey,
        token: entry.token,
        origin,
        name: entry.reclaimKey,
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
  from: Origin,
  origin: string,
  key: string | null,
  request: PageConnectRequest,
): Promise<SessionEntry | undefined> {
  if (!key) return undefined;
  const record = await loadResume(origin, key);
  if (!record) return undefined;
  if (record.expiresAt <= Date.now()) {
    observe(clearResume(origin, key, record.id), 'failed to clear expired resume record', {
      sessionId: record.id,
      data: { origin, surface: request.name },
    });
    return undefined;
  }
  // A live entry already owns this session; the relay would refuse anyway
  // (already_attached), so do not even race it.
  for (const entry of sessions.values()) {
    if (entry.reclaimKey === key) return undefined;
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
      decide: (prompt) => askApproval(origin, who, prompt, synthesisedNames(request)),
    });
    who.name = session.info.agentName;
    const entry: SessionEntry = {
      ref,
      port,
      from,
      origin,
      tabId: port.sender?.tab?.id,
      frameId: port.sender?.frameId,
      name: request.name,
      reclaimKey: key,
      session,
      token: record.token,
      who,
      toolNames: new Set(request.tools.map((tool) => tool.name)),
      pending: new Map(),
      activePrompts: new Set(),
      parked: new Set(),
      missedEvents: 0,
    };
    sessions.set(ref, entry);
    refsOf(port).add(ref);
    wireSession(entry);
    return entry;
  } catch (err) {
    const reason = err instanceof ResumeError ? err.reason : '';
    if (reason === 'not_resumable' || reason === 'grant_expired') {
      // Proven dead. Anything else is transient — keep the token for retry.
      observe(clearResume(origin, key, record.id), 'failed to clear dead resume record', {
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

/**
 * Wait for the next document to bind this session.
 *
 * The agent clicks a link and then reads the page it landed on. Failing that
 * read because the document is mid-navigation would make the harness useless
 * exactly when it works; waiting forever would wedge the turn, because the
 * daemon has no tool-call timeout of its own. So: a bounded wait, and a
 * truthful error when the document never came back.
 */
function awaitRebind(entry: SessionEntry): Promise<chrome.runtime.Port> {
  return new Promise<chrome.runtime.Port>((resolve, reject) => {
    const settle = (outcome: { port: chrome.runtime.Port } | { error: string }): void => {
      clearTimeout(timer);
      entry.parked.delete(settle);
      if ('port' in outcome) resolve(outcome.port);
      else reject(new Error(outcome.error));
    };
    const timer = setTimeout(() => {
      log.warn('tool call gave up waiting for the page to come back', {
        sessionId: entry.session.id,
        data: { origin: entry.origin, waitedMs: NAV_SETTLE_MS },
      });
      settle({ error: 'the page navigated and did not come back' });
    }, NAV_SETTLE_MS);
    entry.parked.add(settle);
  });
}

/** A tool call goes back to whoever registered the tool, and nowhere else. */
async function dispatchToolCall(ref: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const entry = sessions.get(ref);
  if (!entry) throw new Error('session is gone');
  if (!entry.toolNames.has(name)) throw new Error(`tool ${name} is not in this grant`);
  if (entry.pending.size + entry.parked.size >= LIMITS.pendingCallsPerSession) {
    throw new Error('too many tool calls in flight');
  }

  const port = entry.port ?? (await awaitRebind(entry));
  // The wait is an await: re-check that this session is still the live one and
  // that the tool the reclaiming document declared is still this tool.
  if (sessions.get(ref) !== entry) throw new Error('session is gone');
  if (!entry.toolNames.has(name)) throw new Error(`tool ${name} is not in this grant`);

  const callId = mintId('c_');
  const deferred = new Deferred<{ ok: boolean; result?: unknown; error?: string }>();
  entry.pending.set(callId, deferred);
  post(port, { t: 'tool.call', ref, callId, name, arguments: args });

  const outcome = await deferred.promise;
  if (!outcome.ok) throw new Error(outcome.error ?? 'tool call failed');
  return outcome.result;
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
  noteDocument(port);
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
      // One lifecycle. A surface that has a reclaim identity is parked for the
      // next document; a surface that has none cannot outlive this document —
      // an opaque origin nobody could have consented to, or a widget grant
      // harvested from THIS document's WebMCP registrations.
      if (entry.reclaimKey) orphanSession(entry);
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
      // The content script says which surface is asking; the browser says who
      // it is. The reclaim key is built from the browser's answer.
      const from: Origin = message.from === 'widget' ? 'widget' : 'page';
      const origin = originOf(port);
      const key = reclaimKeyFor({
        from,
        origin,
        name: request.name,
        tabId: port.sender?.tab?.id,
        toolSource: request.context?.['source'],
      });
      // Worker-held first (nothing crossed the network); relay-token second.
      let entry = reclaimSession(port, origin, key, request);
      if (!entry) entry = await resumeFromStore(port, from, origin, key, request);
      post(port, {
        t: 'ok',
        rid: message.rid,
        value: entry
          ? {
              ref: entry.ref,
              info: await infoFor(entry),
              grant: grantFor(entry),
              activePrompts: [...entry.activePrompts],
              // The plan the agent is working to right now, so the document
              // that just arrived renders the progress of the turn it walked
              // into instead of a blank panel above a running composer.
              ...(entry.plan ? { plan: entry.plan.steps } : {}),
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
      // A document that reclaims this session mid-turn asks for these: without
      // them it renders an idle composer while the agent is still speaking.
      entry.activePrompts.add(request.id);
      request.result.then(
          (text) => {
            entry.activePrompts.delete(request.id);
            post(port, { t: 'ok', rid: message.rid, value: text });
          },
          (err: unknown) => {
            entry.activePrompts.delete(request.id);
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
    case 'answer': {
      // `lookup` is the ownership check: this port must hold this ref. The
      // wallet then refuses an ask id it never issued, and the daemon refuses
      // one it has already settled — delete-before-resolve there means a
      // duplicate answer is a no-op rather than a second, contradictory one.
      const entry = lookup(port, message.ref);
      if (!entry) {
        log.warn('dropped an answer for a session this port does not hold', { data: { ref: message.ref } });
        return;
      }
      // `Object.fromEntries`, not assignment into a literal: it DEFINES own
      // properties, so a field key of `__proto__` becomes a plain key instead
      // of reaching the prototype setter. The pairs were already validated
      // against the wire's own key pattern and length bound at the page
      // boundary, so this is the first and only place they become an object.
      entry.session.answer(message.askId, Object.fromEntries((message.values ?? []).map((f) => [f.key, f.value])));
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
    default: {
      // Exhaustive for the same reason content.ts's is: bridge.ts proves every
      // ContentToWorker member is VALIDATED and nothing proved one is HANDLED,
      // so a new member forgotten here is dropped silently at the worker hop
      // instead of the page hop. Same bug, next boundary out.
      const unhandled: never = message;
      void unhandled;
      return;
    }
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
