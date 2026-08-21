/**
 * The mediator.
 *
 * Runs in the extension's isolated world: it can see the page's DOM but the
 * page cannot see it, and it holds the only channel to the service worker. Two
 * kinds of traffic pass through here and they are kept strictly apart:
 *
 *   page traffic    — requests, always re-validated, never trusted about
 *                     identity, session ownership or tool ownership;
 *   widget traffic  — the extension acting as the surface for sites that do not
 *                     speak `navigator.agent` (Job 2).
 *
 * The page cannot address a widget session and the widget cannot be driven by
 * the page: both are keyed by references minted in the service worker, and each
 * reference is recorded here with the owner it was created for.
 *
 * WHAT STAYS IN THIS FILE, AND WHY IT IS NOT SPLIT FURTHER
 *
 * The widget's state machine moved out to `widget.ts`, where it can be driven
 * without a browser. What is left is deliberately one piece. `records`,
 * `pageCalls`, `waiters` and `readPageOutbound` are a SINGLE boundary, not four
 * collaborating parts: the validator decides what a page may say, and the three
 * maps are what makes each of those statements answerable exactly once, by the
 * owner it was minted for. Splitting them would put the ownership check and the
 * table it checks against in different files, and the invariant they enforce
 * together — a page may only answer a call this document dispatched to it, and
 * may never address a widget session — is the reason this extension exists.
 * The panel below stays for a different reason: building an extension-origin
 * iframe inside a closed shadow root is `chrome.runtime` work that cannot leave
 * the content script at all.
 */

import { createLogger, type ToolDefinition } from '@agentport/protocol';
import {
  ENVELOPE,
  LIMITS,
  TO_PAGE,
  TO_WALLET,
  isRecord,
  mintId,
  readPageOutbound,
  sanitizeTools,
  type ContentToWorker,
  type ExtensionProviderErrorReason,
  type Origin,
  type PageConnectRequest,
  type PageInbound,
  type WorkerToContent,
} from './bridge.js';
import type { OverlayAction, OverlayCommand } from './overlay.js';
import { describeHandle, genericPageTools } from './pagetools.js';
import { AGENTPORT_VERSION } from './version.js';
import {
  WidgetSurface,
  type OverlayBridge,
  type OverlayHost,
  type ToolRoute,
  type WidgetToolSource,
} from './widget.js';

const CHANNEL = mintId('ch_');
const TOOL_CALL_TIMEOUT_MS = 30_000;
const PAIR_CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const log = createLogger('extension.content');

interface SessionRecord {
  ref: string;
  owner: Origin;
  routes: Map<string, ToolRoute>;
}

const records = new Map<string, SessionRecord>();
const pageCalls = new Map<string, { ref: string; settle: (outcome: { ok: boolean; result?: unknown; error?: string }) => void }>();
const waiters = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();

/** WebMCP tools the page has registered, harvested by the in-page script. */
let webmcpTools: ToolDefinition[] = [];

// --- service worker port ---------------------------------------------------

let port: chrome.runtime.Port | undefined;

function workerPort(): chrome.runtime.Port {
  if (port) return port;
  const next = chrome.runtime.connect({ name: 'agentport.content' });
  next.onMessage.addListener((raw: unknown) => {
    if (isRecord(raw)) onWorkerMessage(raw as WorkerToContent);
  });
  next.onDisconnect.addListener(() => {
    port = undefined;
    for (const waiter of waiters.values()) waiter.reject(new Error('wallet disconnected'));
    waiters.clear();
    for (const record of records.values()) closeRecord(record, 'wallet_disconnected');
  });
  port = next;
  next.postMessage({ t: 'hello', version: AGENTPORT_VERSION } satisfies ContentToWorker);
  return next;
}

function tell(message: ContentToWorker): void {
  try {
    workerPort().postMessage(message);
  } catch (err) {
    log.warn('failed to send message to extension worker', { err, data: { messageType: message.t } });
    port = undefined;
    if ('rid' in message) {
      waiters.get(message.rid)?.reject(new Error('wallet disconnected'));
      waiters.delete(message.rid);
    }
  }
}

function request<T>(build: (rid: string) => ContentToWorker, timeoutMs?: number): Promise<T> {
  const rid = mintId('q_');
  return new Promise<T>((resolve, reject) => {
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      if (!waiters.delete(rid)) return;
      reject(new Error('the wallet did not answer in time'));
    }, timeoutMs);
    waiters.set(rid, {
      resolve: (value: unknown) => {
        clearTimeout(timer);
        (resolve as (value: unknown) => void)(value);
      },
      reject: (err: Error) => {
        clearTimeout(timer);
        reject(err);
      },
    });
    tell(build(rid));
  });
}

function closeRecord(record: SessionRecord, reason: string): void {
  records.delete(record.ref);
  if (record.owner === 'page') toPage({ t: 'event', ref: record.ref, event: 'closed', payload: { reason } });
  else widget.closed(reason);
}

// --- page boundary ---------------------------------------------------------

function toPage(body: PageInbound): void {
  window.postMessage({ e: ENVELOPE, dir: TO_PAGE, channel: CHANNEL, body }, window.origin === 'null' ? '*' : window.origin);
}

function injectProvider(): void {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inpage.js');
  // Not a secret — the page can read this attribute. It separates our traffic
  // from every other postMessage on the page; authority never derives from it.
  script.dataset.channel = CHANNEL;
  script.async = false;
  script.addEventListener('load', () => script.remove());
  (document.head ?? document.documentElement).append(script);
}

/** The pairing link contains no authority: it only opens an extension-owned
 * confirmation. The content script reports success into the otherwise static
 * page so the user never has to open the popup or paste a code. */
function handlePairingLink(): void {
  if (window.top !== window || location.pathname !== '/pair') return;
  const code = new URLSearchParams(location.hash.slice(1)).get('code')?.trim().toUpperCase();
  if (!code || !PAIR_CODE.test(code)) return;
  const status = () => document.getElementById('pair-status');
  const show = (message: string, failed = false) => {
    const target = status();
    if (!target) {
      document.addEventListener('DOMContentLoaded', () => show(message, failed), { once: true });
      return;
    }
    target.textContent = message;
    target.dataset['state'] = failed ? 'error' : 'done';
  };
  request<{ agent: { name: string } }>((rid) => ({ t: 'pair.link', rid, code })).then(
    (result) => show(`${result.agent.name} is paired. You can close this tab.`),
    (err: Error) => show(err.message, true),
  );
}

window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data: unknown = event.data;
  if (!isRecord(data) || data['e'] !== ENVELOPE || data['dir'] !== TO_WALLET || data['channel'] !== CHANNEL) return;

  // Everything below this line came from a hostile context. `readPageOutbound`
  // rebuilds it; anything it cannot rebuild is dropped without a reply, because
  // a parse error is not something the page is owed an answer about.
  const body = readPageOutbound(data['body']);
  if (!body) return;

  switch (body.t) {
    case 'available': {
      // Deliberately *not* a relay round-trip. Answering "do you have agents?"
      // by dialing the relay would let any page force a socket and leak the
      // fact that this user has agents at all before consent.
      request<{ hasIdentity: boolean }>((rid) => ({ t: 'status', rid })).then(
        (status) => toPage({ t: 'ok', rid: body.rid, value: status.hasIdentity === true }),
        () => toPage({ t: 'ok', rid: body.rid, value: false }),
      );
      return;
    }
    case 'connect': {
      void connectForPage(body.rid, body.request);
      return;
    }
    case 'resume': {
      void resumeForPage(body.rid, body.request);
      return;
    }
    case 'history': {
      const record = ownedBy(body.ref, 'page');
      if (!record) return void toPage({ t: 'err', rid: body.rid, reason: 'denied', message: 'unknown session' });
      request<unknown>((rid) => ({ t: 'history', rid, ref: record.ref })).then(
        (entries) => toPage({ t: 'ok', rid: body.rid, value: entries }),
        (err: Error) => toPage({ t: 'err', rid: body.rid, reason: 'error', message: err.message }),
      );
      return;
    }
    case 'prompt': {
      const record = ownedBy(body.ref, 'page');
      if (!record) return void toPage({ t: 'err', rid: body.rid, reason: 'denied', message: 'unknown session' });
      request<string>((rid) => ({ t: 'prompt', rid, ref: record.ref, promptId: body.promptId, text: body.text, context: body.context })).then(
        (text) => toPage({ t: 'ok', rid: body.rid, value: text }),
        (err: Error) => toPage({ t: 'err', rid: body.rid, reason: 'error', message: err.message }),
      );
      return;
    }
    case 'prompt.cancel': {
      const record = ownedBy(body.ref, 'page');
      if (record) tell({ t: 'prompt.cancel', ref: record.ref, promptId: body.promptId });
      return;
    }
    case 'answer': {
      // Settling what ADR-024 R12 left open: the page-world provider keeps
      // `ask`/`answer` so a site sees the SAME `navigator.agent` session shape
      // on every tier — a method that throws here and works on the in-page
      // tier would be worse than one that never fires — but no answer from
      // page world is legitimate on this tier any more. Questions render in
      // extension chrome and are answered there, so the page has no ask id it
      // could have come by honestly.
      //
      // So this is refused, not forwarded, and said out loud: a page reaching
      // this line is confused or hostile, and either is worth seeing. The
      // validator above stays exactly as strict, because a boundary that only
      // holds while the routing above it is correct is not a boundary.
      //
      // And there is no longer anywhere to forward it TO: `ContentToWorker`
      // has no `answer` member and the worker has no handler, because once
      // the consent window started answering questions nothing produced one.
      // That is deliberate rather than incidental — the worker's handler put
      // an answer on the wire under the user's authority, and a path carrying
      // that which nothing can reach is the worst kind to leave lying about.
      log.error('refused an answer composed in page world; questions are answered in extension chrome', {
        data: { ref: body.ref },
      });
      return;
    }
    case 'tool.result': {
      // The page may only answer a call we dispatched to it, exactly once. The
      // session reference comes from our own table, never from the message.
      const call = pageCalls.get(body.callId);
      if (!call) return;
      pageCalls.delete(body.callId);
      call.settle(body.ok ? { ok: true, result: body.result } : { ok: false, error: body.error });
      return;
    }
    case 'close': {
      const record = ownedBy(body.ref, 'page');
      if (record) {
        records.delete(record.ref);
        tell({ t: 'close', ref: record.ref, reason: body.reason });
      }
      return;
    }
    case 'webmcp.tools': {
      webmcpTools = sanitizeTools(body.tools);
      if (webmcpTools.length > 0) revealOverlay();
      return;
    }
    default: {
      // EXHAUSTIVE, not a catch-all. bridge.ts already fails the build for a
      // PageOutbound member nothing VALIDATES; nothing proved a validated
      // member is HANDLED, so adding one and forgetting a case here was the
      // identical silent drop, one hop further out — the same bug that guard
      // was written to fix, at the next boundary.
      //
      // Unreachable at runtime: readPageOutbound refused anything outside the
      // union before this. The return is belt; the annotation is the property.
      const unhandled: never = body;
      void unhandled;
      return;
    }
  }
});

/**
 * A question the agent asked could not be put to the user.
 *
 * The routing itself moved to the service worker (ADR-024 R12): a question
 * opens the same extension-origin window every approval uses, so it never
 * reaches page world and the page never composes the answer. What arrives here
 * is only the worker saying it had to SKIP one — the window would not open, it
 * went unanswered before the agent stopped listening, or the session died
 * underneath it.
 *
 * The user is still told, because a question they never got the chance to
 * answer changes how much they should trust what comes next (ADR-024 R4). A
 * skip carries no authority and attributes nothing to them, which is exactly
 * why it is the safe thing to send on their behalf and an ANSWER never would
 * be.
 *
 * Honest limit: the notice needs a surface, and on a page-declared site where
 * the user never opened the widget there is no extension surface to draw on.
 * It is logged there and nothing more. Giving the overlay a life of its own
 * just to carry notices is a bigger change than this one.
 */
function noticeAskSkipped(ref: string, payload: unknown): void {
  const message = isRecord(payload) && typeof payload['message'] === 'string' ? payload['message'] : undefined;
  log.warn('a question could not be put to the user; the agent was told it was skipped', {
    data: { ref, hasSurface: overlayInstance !== undefined },
  });
  overlayInstance?.notice(
    message
      ? `Your agent asked you something and it could not be shown, so it was skipped — expect a guess.`
      : 'Your agent asked you a question that could not be shown, so it was skipped — expect a guess.',
  );
}

function ownedBy(ref: string, owner: Origin): SessionRecord | undefined {
  const record = records.get(ref);
  return record && record.owner === owner ? record : undefined;
}

async function connectForPage(pageRid: string, request_: PageConnectRequest): Promise<void> {
  try {
    const value = await request<{ ref: string; info: unknown; grant: unknown }>((rid) => ({
      t: 'connect',
      rid,
      from: 'page',
      request: request_,
    }));
    records.set(value.ref, {
      ref: value.ref,
      owner: 'page',
      routes: new Map(request_.tools.map((tool) => [tool.name, 'page' as ToolRoute])),
    });
    toPage({ t: 'ok', rid: pageRid, value });
  } catch (err) {
    const reason = errorReason(err);
    toPage({ t: 'err', rid: pageRid, reason, message: err instanceof Error ? err.message : String(err) });
  }
}

async function resumeForPage(pageRid: string, request_: PageConnectRequest): Promise<void> {
  try {
    const value = await request<{ ref: string; info: unknown; grant: unknown } | null>((rid) => ({
      t: 'resume',
      rid,
      from: 'page',
      request: request_,
    }));
    if (value) {
      // Same bookkeeping as a fresh connect: tool calls for this ref route to
      // the page that just re-declared the handlers.
      records.set(value.ref, {
        ref: value.ref,
        owner: 'page',
        routes: new Map(request_.tools.map((tool) => [tool.name, 'page' as ToolRoute])),
      });
    }
    toPage({ t: 'ok', rid: pageRid, value });
  } catch (err) {
    const reason = errorReason(err);
    toPage({ t: 'err', rid: pageRid, reason, message: err instanceof Error ? err.message : String(err) });
  }
}

function errorReason(err: unknown): ExtensionProviderErrorReason {
  const reason = err instanceof Error && 'reason' in err ? (err as Error & { reason: unknown }).reason : undefined;
  switch (reason) {
    case 'no_agents':
    case 'cancelled':
    case 'denied':
    case 'error':
    case 'extension_updating':
      return reason;
    default:
      return 'denied';
  }
}

// --- worker → here ---------------------------------------------------------

function onWorkerMessage(message: WorkerToContent): void {
  switch (message.t) {
    case 'hello': {
      if (!message.compatible || message.version !== AGENTPORT_VERSION) {
        log.warn('extension build mismatch during worker handshake', {
          data: { contentVersion: AGENTPORT_VERSION, workerVersion: message.version },
        });
      }
      return;
    }
    case 'ok': {
      const waiter = waiters.get(message.rid);
      waiters.delete(message.rid);
      waiter?.resolve(message.value);
      return;
    }
    case 'err': {
      const waiter = waiters.get(message.rid);
      waiters.delete(message.rid);
      const error = Object.assign(new Error(message.message), { reason: message.reason });
      waiter?.reject(error);
      return;
    }
    case 'tool.call': {
      void runToolCall(message);
      return;
    }
    case 'describe': {
      // The approval card's target line, computed where the DOM is. A throw
      // from describeHandle IS the answer — the page changed under the
      // request, or the handle never existed — and it crosses as a refusal
      // the card renders in its own alarmed words, never as silence.
      try {
        const described = describeHandle(message.element);
        tell({
          t: 'describe.result',
          rid: message.rid,
          target: {
            role: described.role,
            name: described.name,
            obstruction: described.obstruction.state,
            ...(described.obstruction.state === 'blocked'
              ? { detail: described.obstruction.by }
              : described.obstruction.state === 'unknown'
                ? { detail: described.obstruction.why }
                : {}),
          },
        });
      } catch (err) {
        tell({ t: 'describe.result', rid: message.rid, refusal: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    case 'event': {
      const record = records.get(message.ref);
      if (!record) return;
      // `ask` is checked BEFORE ownership, because ownership is exactly the
      // wrong discriminator for it: a page-owned session is the case where
      // forwarding is most tempting and least safe. The worker no longer
      // emits it — questions go to extension chrome — so this is the boundary
      // holding independently of the policy above it, not a live path. A
      // boundary that only holds while the routing is correct is not one.
      if (message.event === 'ask') {
        log.error('the worker forwarded a question to a document; refusing to hand the user voice to the page', {
          data: { ref: message.ref },
        });
      } else if (message.event === 'ask.skipped') {
        noticeAskSkipped(message.ref, message.payload);
      } else if (record.owner === 'page') {
        toPage({ t: 'event', ref: message.ref, event: message.event, payload: message.payload });
      } else {
        widget.event(message.event, message.payload);
      }
      if (message.event === 'closed') records.delete(message.ref);
      return;
    }
    default:
      return;
  }
}

async function runToolCall(call: Extract<WorkerToContent, { t: 'tool.call' }>): Promise<void> {
  const record = records.get(call.ref);
  const route = record?.routes.get(call.name);
  if (!record || !route) {
    tell({ t: 'tool.result', ref: call.ref, callId: call.callId, ok: false, error: `unknown tool ${call.name}` });
    return;
  }

  if (route === 'page') {
    if (pageCalls.size >= LIMITS.pendingCallsPerSession) {
      tell({ t: 'tool.result', ref: call.ref, callId: call.callId, ok: false, error: 'too many tool calls in flight' });
      return;
    }
    // A page that simply never answers must not wedge the agent's turn.
    const timer = setTimeout(() => {
      if (!pageCalls.delete(call.callId)) return;
      tell({ t: 'tool.result', ref: call.ref, callId: call.callId, ok: false, error: 'the page did not answer in time' });
    }, TOOL_CALL_TIMEOUT_MS);
    pageCalls.set(call.callId, {
      ref: call.ref,
      settle: (outcome) => {
        clearTimeout(timer);
        tell({ t: 'tool.result', ref: call.ref, callId: call.callId, ...outcome });
      },
    });
    toPage({ t: 'tool.call', callId: call.callId, ref: call.ref, name: call.name, arguments: call.arguments });
    return;
  }

  try {
    const result = await route(call.arguments ?? {});
    tell({ t: 'tool.result', ref: call.ref, callId: call.callId, ok: true, result });
  } catch (err) {
    tell({
      t: 'tool.result',
      ref: call.ref,
      callId: call.callId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Job 2 — the panel the fallback surface is drawn in
//
// The state machine this panel drives — attachment, turn, plan, fingerprint
// words, transcript bookkeeping — is `WidgetSurface` in `widget.ts`, which is
// free of Chrome APIs and therefore assertable in `check.ts`. What is left here
// is the part that cannot leave: an extension-origin iframe inside a closed
// shadow root, built with `chrome.runtime` and wired over a private
// `MessagePort`.
//
// `widgetSurfaceAlive` is DELETED rather than moved. It was set true in exactly
// the place `overlayInstance` is assigned and false in exactly the place
// `overlayInstance` is cleared — both synchronously, with nothing between them
// that reads either — so "is there a panel" already answered it, and the
// `WidgetSurface` asks that question instead. Two variables that must agree are
// two variables that can one day disagree.
// ---------------------------------------------------------------------------

let overlayInstance: OverlayBridge | undefined;
let overlaySuppressed = false;

function overlay(): OverlayBridge {
  if (overlayInstance) return overlayInstance;

  // The page cannot traverse this closed root, so it cannot obtain the iframe
  // or its contentWindow. The content script alone keeps the MessagePort that
  // carries semantic UI commands/actions; no page data is accepted here.
  const host = document.createElement('div');
  host.setAttribute('data-agentport-ui', '');
  host.style.cssText = 'all:initial;';
  const root = host.attachShadow({ mode: 'closed' });
  const frame = document.createElement('iframe');
  // A hostile parent can never read this fragment cross-origin. It authenticates
  // the port transfer even if a browser exposes a shadow-tree frame through an
  // unexpected browsing-context enumeration.
  const overlaySecret = mintId('overlay_');
  frame.src = `${chrome.runtime.getURL('overlay.html')}#${overlaySecret}`;
  frame.title = 'AgentPort';
  frame.style.cssText = [
    'position:fixed',
    'right:0',
    'bottom:0',
    'width:80px',
    'height:80px',
    'border:0',
    'z-index:2147483647',
    'background:transparent',
    'overflow:hidden',
  ].join(';');
  root.append(frame);
  (document.documentElement ?? document.body).append(host);

  const channel = new MessageChannel();
  const queued: OverlayCommand[] = [];
  let connected = false;
  let disposed = false;
  let removalObserver: MutationObserver | undefined;

  const send = (command: OverlayCommand): void => {
    if (connected) channel.port1.postMessage(command);
    else queued.push(command);
  };
  const setExpanded = (expanded: boolean): void => {
    frame.style.width = expanded ? 'min(426px, 100vw)' : '80px';
    frame.style.height = expanded ? 'min(652px, 100vh)' : '80px';
  };
  const disposeBridge = (reason: string): void => {
    if (disposed) return;
    disposed = true;
    removalObserver?.disconnect();
    channel.port1.close();
    queued.length = 0;
    overlaySuppressed = true;
    // Cleared BEFORE the surface is told, so that everything the widget does in
    // response already sees a document with nowhere to draw.
    overlayInstance = undefined;
    widget.surfaceLost(reason);
  };

  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const action = event.data;
    if (!isRecord(action) || typeof action['t'] !== 'string') return;
    switch ((action as OverlayAction).t) {
      case 'overlay.attach':
        void widget.attach();
        return;
      case 'overlay.detach':
        widget.detach();
        return;
      case 'overlay.layout':
        if (typeof action['expanded'] === 'boolean') setExpanded(action['expanded']);
        return;
      case 'chat.prompt':
        if (
          typeof action['id'] !== 'string' ||
          action['id'].length > 128 ||
          typeof action['text'] !== 'string' ||
          action['text'].length > LIMITS.textLength
        ) return;
        {
          const accepted = widget.send(action['text']);
          if (accepted) overlay().addUserMessage(action['text']);
          send({ t: 'overlay.action-result', id: action['id'], accepted });
        }
        return;
      case 'chat.cancel':
        widget.cancel();
        return;
      default:
        return;
    }
  };
  channel.port1.start();
  frame.addEventListener('load', () => {
    if (connected) {
      disposeBridge('widget_reloaded');
      return;
    }
    // The iframe URL is extension-origin. The page cannot name this browsing
    // context because it is nested in the closed root above.
    frame.contentWindow?.postMessage(
      { t: 'agentport.overlay.connect', secret: overlaySecret },
      new URL(frame.src).origin,
      [channel.port2],
    );
    connected = true;
    for (const command of queued.splice(0)) channel.port1.postMessage(command);
  });

  removalObserver = new MutationObserver(() => {
    if (!host.isConnected) disposeBridge('widget_removed');
  });
  removalObserver.observe(document, { childList: true, subtree: true });

  overlayInstance = {
    show: () => send({ t: 'overlay.show' }),
    setState: (phase, agentName) => send({ t: 'overlay.state', phase, agentName }),
    addUserMessage: (content) => send({ t: 'chat.add-user', content }),
    apply: (update) => send({ t: 'chat.update', update }),
    notice: (text) => send({ t: 'overlay.notice', text }),
    plan: (steps) => send({ t: 'overlay.plan', steps }),
    verify: (words) => send({ t: 'overlay.verify', words }),
    reset: () => send({ t: 'chat.reset' }),
  };
  return overlayInstance;
}

/**
 * The panel, as the widget is allowed to see it: built on demand, and
 * separately observable WITHOUT being built. `overlaySuppressed` is not in this
 * interface on purpose — it answers whether a document that already tore its
 * panel down should get another one, which is this file's business rather than
 * the state machine's.
 */
const overlayHost: OverlayHost = {
  open: overlay,
  panel: () => overlayInstance,
};

/** Put the panel on screen unless this document already tore one down. The
 *  suppression is checked here rather than inside `overlay()` because the paths
 *  that ATTACH must still be able to build one — an attach can only come from a
 *  panel the user is looking at. */
function revealOverlay(): void {
  if (!overlaySuppressed) overlay().show();
}

function documentReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise<void>((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

/**
 * The fallback surface for this document.
 *
 * Everything it needs from the browser arrives through these members, so the
 * state machine itself has no ambient dependency and `check.ts` can drive the
 * same transitions with a recording bridge and no DOM at all.
 */
const widget = new WidgetSurface({
  host: overlayHost,
  page: {
    /** What the widget asks for, on a fresh attach and on a reclaim alike. The
     *  `source` is how the worker knows whether this grant can outlive the
     *  document that declared it. */
    connectRequest: (tools: ToolDefinition[], source: WidgetToolSource): PageConnectRequest => ({
      name: document.title || location.hostname,
      route: location.pathname,
      context: { url: location.href, title: document.title, source },
      tools,
      alwaysAsk: [],
    }),
    webmcpTools: () => webmcpTools,
    genericTools: genericPageTools,
    ready: documentReady,
    origin: () => location.origin,
  },
  tell,
  request,
  // The routing table stays here, beside the ownership check that reads it. The
  // widget says which tools its own grant covers; it never says who owns a
  // session, and it never removes a record — a record dies when the worker says
  // the session closed.
  bindSession: (ref, routes) => {
    records.set(ref, { ref, owner: 'widget', routes });
  },
});

// --- boot ------------------------------------------------------------------

injectProvider();
handlePairingLink();

// Only the top frame gets a widget: a floating panel per iframe would be noise,
// and an iframe is not where a user expects to grant page-wide capabilities.
if (window.top === window) {
  // Opening the port IS the announcement: the worker reads this document's
  // origin and tab from the browser's own stamp on it, and closes any
  // attachment the tab left behind on another origin. Subframes stay silent —
  // a cross-origin iframe must not be able to detach the tab's session.
  workerPort();
  if (location.pathname !== '/pair') {
    // Before anything is rendered, because a tool call the agent issued just
    // before the navigation is already parked in the worker waiting for a
    // document to bind. Failures inside are logged and surfaced there.
    void widget.reclaim();
    const start = () => overlay().show();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
}
