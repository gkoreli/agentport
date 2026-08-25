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
 */

import type { SiteTool } from '@agentport/client';
import { createLogger, type HistoryEntry, type ToolDefinition } from '@agentport/protocol';
import type { ChatUpdate } from '../../../src/nisli-ui/ui/chat/index.js';
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
import type { OverlayAction, OverlayCommand, WidgetPhase } from './overlay.js';
import { genericPageTools } from './pagetools.js';
import { AGENTPORT_VERSION } from './version.js';

const CHANNEL = mintId('ch_');
const TOOL_CALL_TIMEOUT_MS = 30_000;
/** The agent's own store answers this; a runtime that never answers must not
 *  leave the reattached widget waiting on a promise nobody settles. */
const WIDGET_HISTORY_TIMEOUT_MS = 20_000;
const PAIR_CODE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const log = createLogger('extension.content');

type ToolRoute = 'page' | ((args: Record<string, unknown>) => unknown | Promise<unknown>);

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
  else onWidgetClosed(reason);
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
      if (webmcpTools.length > 0 && !overlaySuppressed) overlay().show();
      return;
    }
    default:
      return;
  }
});

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
    case 'event': {
      const record = records.get(message.ref);
      if (!record) return;
      if (record.owner === 'page') toPage({ t: 'event', ref: message.ref, event: message.event, payload: message.payload });
      else onWidgetEvent(message.event, message.payload);
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
// Job 2 — the fallback surface
//
// When the site does not speak `navigator.agent`, the extension becomes the
// surface. Preference order for what the agent gets:
//
//   1. the site's own WebMCP tools, if it registered any — those carry intent;
//   2. otherwise the generic `page.*` DOM toolset.
//
// Either way the grant goes through the same consent screen and the same
// per-call approvals as a site-declared grant.
//
// A widget attachment outlives a same-origin navigation: the next document
// asks the worker to hand it back (`reclaimWidget`, at document_start) and
// rehydrates the transcript from the agent's own store. Only the generic
// toolset can do that — a grant harvested from a document's own WebMCP
// registrations belongs to THAT document, so the worker refuses to park it.
// Leaving the origin is not a navigation the attachment follows at all: the
// worker closes it when this tab's next top-level document announces a
// different origin.
// ---------------------------------------------------------------------------

interface OverlayBridge {
  show(): void;
  setState(phase: WidgetPhase, agentName?: string): void;
  addUserMessage(content: string): void;
  apply(update: ChatUpdate): void;
  notice(text: string): void;
  reset(): void;
}

let overlayInstance: OverlayBridge | undefined;
let overlaySuppressed = false;
let widgetSurfaceAlive = false;
let widgetRef: string | undefined;
let widgetPromptId: string | undefined;
let widgetAttaching = false;
let widgetToolSeq = 0;
/** Set as soon as the agent says anything to THIS document. A history replay
 *  must never overwrite a transcript the user is already reading. */
let widgetLiveSinceBind = false;
const widgetTextMessages = new Set<string>();
const widgetReasoningMessages = new Set<string>();

interface WidgetAttachment {
  ref: string;
  info: { agentName: string };
  /** Turns the agent is still working on, so a document that arrives mid-turn
   *  renders a running turn instead of an idle composer. */
  activePrompts?: string[];
}

function displayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function overlay(): OverlayBridge {
  if (overlayInstance) return overlayInstance;
  widgetSurfaceAlive = true;

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
    const ref = widgetRef;
    widgetRef = undefined;
    widgetPromptId = undefined;
    widgetAttaching = false;
    widgetTextMessages.clear();
    widgetReasoningMessages.clear();
    widgetSurfaceAlive = false;
    overlaySuppressed = true;
    overlayInstance = undefined;
    if (ref) tell({ t: 'close', ref, reason });
  };

  channel.port1.onmessage = (event: MessageEvent<unknown>) => {
    const action = event.data;
    if (!isRecord(action) || typeof action['t'] !== 'string') return;
    switch ((action as OverlayAction).t) {
      case 'overlay.attach':
        void attachWidget();
        return;
      case 'overlay.detach':
        if (widgetRef) tell({ t: 'close', ref: widgetRef, reason: 'user_detached' });
        widgetRef = undefined;
        widgetPromptId = undefined;
        overlay().reset();
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
          const accepted = sendFromWidget(action['text']);
          if (accepted) overlay().addUserMessage(action['text']);
          send({ t: 'overlay.action-result', id: action['id'], accepted });
        }
        return;
      case 'chat.cancel':
        if (widgetRef && widgetPromptId) tell({ t: 'prompt.cancel', ref: widgetRef, promptId: widgetPromptId });
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
    reset: () => send({ t: 'chat.reset' }),
  };
  return overlayInstance;
}

/** What the widget asks for, on a fresh attach and on a reclaim alike. The
 *  `source` is how the worker knows whether this grant can outlive the
 *  document that declared it. */
function widgetConnectRequest(tools: ToolDefinition[], source: 'webmcp' | 'page-dom'): PageConnectRequest {
  return {
    name: document.title || location.hostname,
    route: location.pathname,
    context: { url: location.href, title: document.title, source },
    tools,
    alwaysAsk: [],
  };
}

function bindWidget(ref: string, routes: Map<string, ToolRoute>): void {
  records.set(ref, { ref, owner: 'widget', routes });
  widgetRef = ref;
  widgetAttaching = false;
  widgetLiveSinceBind = false;
}

function showWidgetAttached(ui: OverlayBridge, agentName: string): void {
  ui.setState('attached', agentName);
  // A turn was already running when this document arrived; render it as such
  // so the composer offers Stop instead of pretending the agent is idle.
  if (widgetPromptId) ui.apply({ type: 'run.start' });
}

async function attachWidget(): Promise<void> {
  const ui = overlay();
  if (widgetRef || widgetAttaching) return;
  widgetAttaching = true;
  ui.setState('attaching');

  const usingWebMcp = webmcpTools.length > 0;
  const local: SiteTool[] = usingWebMcp ? [] : genericPageTools();
  const definitions: ToolDefinition[] = usingWebMcp
    ? webmcpTools
    : local.map(({ handler: _handler, ...definition }) => definition);

  try {
    const value = await request<WidgetAttachment>((rid) => ({
      t: 'connect',
      rid,
      from: 'widget',
      request: widgetConnectRequest(definitions, usingWebMcp ? 'webmcp' : 'page-dom'),
    }));

    if (!widgetSurfaceAlive) {
      widgetAttaching = false;
      tell({ t: 'close', ref: value.ref, reason: 'widget_removed' });
      return;
    }

    const routes = new Map<string, ToolRoute>();
    if (usingWebMcp) for (const tool of webmcpTools) routes.set(tool.name, 'page');
    else for (const tool of local) routes.set(tool.name, tool.handler);

    bindWidget(value.ref, routes);
    showWidgetAttached(ui, value.info.agentName);
    ui.notice(
      usingWebMcp
        ? `Attached with ${webmcpTools.length} tool(s) this site published via WebMCP. This grant ends when you leave this page.`
        : `Attached with the generic page toolset. Reads are free; anything that changes the page asks first.`,
    );
  } catch (err) {
    widgetAttaching = false;
    if (!widgetSurfaceAlive) return;
    ui.setState('idle');
    ui.notice(err instanceof Error ? err.message : String(err));
  }
}

function documentReady(): Promise<void> {
  if (document.readyState !== 'loading') return Promise.resolve();
  return new Promise<void>((resolve) => {
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
  });
}

/**
 * Ask the worker whether this tab already has an attachment on this origin.
 *
 * Runs at document_start on every top-level page, before the overlay exists,
 * for two reasons: a tool call the agent issued just before the navigation is
 * parked in the worker waiting for a document to bind, and opening this port
 * is also how the worker learns which origin the tab is on now — which is what
 * makes a cross-origin navigation detach immediately instead of after the
 * orphan grace.
 */
async function reclaimWidget(): Promise<void> {
  if (widgetRef || widgetAttaching) return;
  widgetAttaching = true;
  const local = genericPageTools();
  let value: WidgetAttachment | null;
  try {
    value = await request<WidgetAttachment | null>((rid) => ({
      t: 'resume',
      rid,
      from: 'widget',
      request: widgetConnectRequest(local.map(({ handler: _handler, ...definition }) => definition), 'page-dom'),
    }));
  } catch (err) {
    widgetAttaching = false;
    log.warn('could not ask the wallet whether this tab has an attachment to reclaim', {
      err,
      data: { origin: location.origin },
    });
    return;
  }
  if (!value) {
    widgetAttaching = false;
    return;
  }

  // Route bindings first: the parked tool call is answered from here, and it
  // must not wait for the DOM or the overlay iframe.
  bindWidget(value.ref, new Map(local.map((tool) => [tool.name, tool.handler])));
  const active = value.activePrompts?.[0];
  if (typeof active === 'string') widgetPromptId = active;

  await documentReady();
  if (widgetRef !== value.ref) return; // detached or closed while we waited
  const ui = overlay();
  ui.show();
  showWidgetAttached(ui, value.info.agentName);
  ui.notice('Reattached after navigation — same agent, same session.');
  await rehydrateWidget(ui, value.ref, value.info.agentName);
}

/** The transcript lives in the agent's own store, never here: this document
 *  kept nothing across the navigation, so it asks the agent for it. */
async function rehydrateWidget(ui: OverlayBridge, ref: string, agentName: string): Promise<void> {
  let entries: HistoryEntry[];
  try {
    entries = await request<HistoryEntry[]>((rid) => ({ t: 'history', rid, ref }), WIDGET_HISTORY_TIMEOUT_MS);
  } catch (err) {
    log.warn('could not restore the conversation from the agent', { err, data: { origin: location.origin } });
    ui.notice(`Could not restore the earlier conversation: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (widgetRef !== ref || !Array.isArray(entries) || entries.length === 0) return;
  if (widgetLiveSinceBind) {
    // The agent spoke while this was in flight. Replaying now would delete the
    // words the user is reading, so say where the rest is instead.
    ui.notice(`${entries.length} earlier message(s) remain in your agent's own history.`);
    return;
  }
  ui.reset();
  for (const entry of entries) {
    const id = `history-${widgetToolSeq++}`;
    if (entry.role === 'user') {
      ui.addUserMessage(entry.text);
    } else if (entry.role === 'agent') {
      ui.apply({ type: 'message.start', id, role: 'assistant' });
      ui.apply({ type: 'message.delta', id, content: { type: 'text', text: entry.text } });
      ui.apply({ type: 'message.end', id });
    } else if (entry.role === 'thought') {
      ui.apply({ type: 'reasoning.start', id });
      ui.apply({ type: 'reasoning.delta', id, content: { type: 'text', text: entry.text } });
      ui.apply({ type: 'reasoning.end', id });
    } else {
      // Tool and approval rows arrive as flat text.
      ui.apply({ type: 'tool.start', id, name: entry.text });
      ui.apply({ type: 'tool.end', id, status: 'complete' });
    }
  }
  // `chat.reset` also clears the phase and the notices, so restate both.
  showWidgetAttached(ui, agentName);
  ui.notice(`Reattached after navigation — ${entries.length} message(s) restored from your agent.`);
}

function sendFromWidget(text: string): boolean {
  const ui = overlayInstance;
  const ref = widgetRef;
  if (!ui || !ref || widgetPromptId) return false;
  const promptId = mintId('p_');
  widgetPromptId = promptId;
  ui.apply({ type: 'run.start' });
  request<string>((rid) => ({ t: 'prompt', rid, ref, promptId, text })).then(
    (full) => {
      // `done` normally settles the run first. This fallback is for a worker
      // that returned a result after losing its event subscription.
      if (widgetPromptId !== promptId) return;
      if (full && !widgetTextMessages.has(promptId)) {
        widgetTextMessages.add(promptId);
        ui.apply({ type: 'message.start', id: promptId, role: 'assistant' });
        ui.apply({ type: 'message.delta', id: promptId, content: { type: 'text', text: full } });
        ui.apply({ type: 'message.end', id: promptId });
      }
      ui.apply({ type: 'run.end' });
      widgetPromptId = undefined;
    },
    (err: Error) => {
      if (widgetPromptId !== promptId) return;
      ui.apply({ type: 'run.error', error: err.message });
      ui.notice(err.message);
      widgetPromptId = undefined;
    },
  );
  return true;
}

function onWidgetEvent(event: string, payload: unknown): void {
  if (event === 'closed') {
    const reason = isRecord(payload) ? String(payload['reason'] ?? 'closed') : 'closed';
    onWidgetClosed(reason);
    return;
  }
  const ui = overlayInstance;
  if (!ui) return;
  if (!isRecord(payload)) return;
  widgetLiveSinceBind = true;
  const promptId = typeof payload['promptId'] === 'string' ? payload['promptId'] : undefined;
  if (event === 'delta' && promptId) {
    if (!widgetTextMessages.has(promptId)) {
      widgetTextMessages.add(promptId);
      ui.apply({ type: 'message.start', id: promptId, role: 'assistant' });
    }
    ui.apply({ type: 'message.delta', id: promptId, content: { type: 'text', text: String(payload['text'] ?? '') } });
  } else if (event === 'thought' && promptId) {
    const id = `${promptId}:reasoning`;
    if (!widgetReasoningMessages.has(id)) {
      widgetReasoningMessages.add(id);
      ui.apply({ type: 'reasoning.start', id });
    }
    ui.apply({ type: 'reasoning.delta', id, content: { type: 'text', text: String(payload['text'] ?? '') } });
  } else if (event === 'tool') {
    const id = `tool-${widgetToolSeq++}`;
    const ok = payload['ok'] === true;
    ui.apply({
      type: 'tool.start',
      id,
      name: String(payload['name'] ?? 'Tool call'),
      input: displayJson(payload['arguments'] ?? {}),
    });
    ui.apply({
      type: 'tool.end',
      id,
      status: ok ? 'complete' : 'error',
      output: ok && payload['result'] !== undefined
        ? [{ type: 'text', text: displayJson(payload['result']) }]
        : undefined,
      error: ok ? undefined : String(payload['error'] ?? 'Tool call failed'),
    });
  } else if (event === 'done' && promptId) {
    if (widgetTextMessages.delete(promptId)) ui.apply({ type: 'message.end', id: promptId });
    const reasoningId = `${promptId}:reasoning`;
    if (widgetReasoningMessages.delete(reasoningId)) ui.apply({ type: 'reasoning.end', id: reasoningId });
    const failed = payload['stopReason'] === 'error';
    ui.apply(failed
      ? { type: 'run.error', error: String(payload['error'] ?? 'Agent run failed') }
      : { type: 'run.end' });
    if (widgetPromptId === promptId) widgetPromptId = undefined;
  }
}

function onWidgetClosed(reason: string): void {
  widgetRef = undefined;
  widgetPromptId = undefined;
  widgetAttaching = false;
  widgetTextMessages.clear();
  widgetReasoningMessages.clear();
  const ui = overlayInstance;
  ui?.reset();
  ui?.notice(`Detached: ${reason}`);
}

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
    void reclaimWidget();
    const start = () => overlay().show();
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }
}
