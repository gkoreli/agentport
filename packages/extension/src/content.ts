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
import { createOverlay, type Overlay } from './overlay.js';
import { genericPageTools } from './pagetools.js';
import { AGENTPORT_VERSION } from './version.js';

const CHANNEL = mintId('ch_');
const TOOL_CALL_TIMEOUT_MS = 30_000;
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

function request<T>(build: (rid: string) => ContentToWorker): Promise<T> {
  const rid = mintId('q_');
  return new Promise<T>((resolve, reject) => {
    waiters.set(rid, { resolve: resolve as (value: unknown) => void, reject });
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
      if (webmcpTools.length > 0) overlay().widget.show();
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
// ---------------------------------------------------------------------------

let overlayInstance: Overlay | undefined;
let widgetRef: string | undefined;
let widgetPromptId: string | undefined;
let widgetToolSeq = 0;
const widgetTextMessages = new Set<string>();
const widgetReasoningMessages = new Set<string>();

function overlay(): Overlay {
  if (!overlayInstance) {
    overlayInstance = createOverlay({
      attach: () => void attachWidget(),
      detach: () => {
        if (widgetRef) tell({ t: 'close', ref: widgetRef, reason: 'user_detached' });
        widgetRef = undefined;
        widgetPromptId = undefined;
        overlay().widget.reset();
      },
      send: sendFromWidget,
      cancel: () => {
        if (widgetRef && widgetPromptId) {
          tell({ t: 'prompt.cancel', ref: widgetRef, promptId: widgetPromptId });
        }
      },
    });
  }
  return overlayInstance;
}

async function attachWidget(): Promise<void> {
  const ui = overlay();
  if (widgetRef) return;
  ui.widget.phase.value = 'attaching';

  const usingWebMcp = webmcpTools.length > 0;
  const local: SiteTool[] = usingWebMcp ? [] : genericPageTools();
  const definitions: ToolDefinition[] = usingWebMcp
    ? webmcpTools
    : local.map(({ handler: _handler, ...definition }) => definition);

  try {
    const value = await request<{ ref: string; info: { agentName: string } }>((rid) => ({
      t: 'connect',
      rid,
      from: 'widget',
      request: {
        name: document.title || location.hostname,
        route: location.pathname,
        context: { url: location.href, title: document.title, source: usingWebMcp ? 'webmcp' : 'page-dom' },
        tools: definitions,
        alwaysAsk: [],
      },
    }));

    const routes = new Map<string, ToolRoute>();
    if (usingWebMcp) for (const tool of webmcpTools) routes.set(tool.name, 'page');
    else for (const tool of local) routes.set(tool.name, tool.handler);

    records.set(value.ref, { ref: value.ref, owner: 'widget', routes });
    widgetRef = value.ref;
    ui.widget.agentName.value = value.info.agentName;
    ui.widget.phase.value = 'attached';
    ui.widget.notice(
      usingWebMcp
        ? `Attached with ${webmcpTools.length} tool(s) this site published via WebMCP.`
        : `Attached with the generic page toolset. Reads are free; anything that changes the page asks first.`,
    );
  } catch (err) {
    ui.widget.phase.value = 'idle';
    ui.widget.notice(err instanceof Error ? err.message : String(err));
  }
}

function sendFromWidget(text: string): boolean {
  const ui = overlay();
  const ref = widgetRef;
  if (!ref || widgetPromptId) return false;
  const promptId = mintId('p_');
  widgetPromptId = promptId;
  ui.widget.addUserMessage(text);
  ui.widget.apply({ type: 'run.start' });
  request<string>((rid) => ({ t: 'prompt', rid, ref, promptId, text })).then(
    (full) => {
      // `done` normally settles the run first. This fallback is for a worker
      // that returned a result after losing its event subscription.
      if (widgetPromptId !== promptId) return;
      if (full && !widgetTextMessages.has(promptId)) {
        widgetTextMessages.add(promptId);
        ui.widget.apply({ type: 'message.start', id: promptId, role: 'assistant' });
        ui.widget.apply({ type: 'message.delta', id: promptId, content: { type: 'text', text: full } });
        ui.widget.apply({ type: 'message.end', id: promptId });
      }
      ui.widget.apply({ type: 'run.end' });
      widgetPromptId = undefined;
    },
    (err: Error) => {
      if (widgetPromptId !== promptId) return;
      ui.widget.apply({ type: 'run.error', error: err.message });
      ui.widget.notice(err.message);
      widgetPromptId = undefined;
    },
  );
  return true;
}

function onWidgetEvent(event: string, payload: unknown): void {
  const ui = overlay();
  if (!isRecord(payload)) return;
  const promptId = typeof payload['promptId'] === 'string' ? payload['promptId'] : undefined;
  if (event === 'delta' && promptId) {
    if (!widgetTextMessages.has(promptId)) {
      widgetTextMessages.add(promptId);
      ui.widget.apply({ type: 'message.start', id: promptId, role: 'assistant' });
    }
    ui.widget.apply({ type: 'message.delta', id: promptId, content: { type: 'text', text: String(payload['text'] ?? '') } });
  } else if (event === 'thought' && promptId) {
    const id = `${promptId}:reasoning`;
    if (!widgetReasoningMessages.has(id)) {
      widgetReasoningMessages.add(id);
      ui.widget.apply({ type: 'reasoning.start', id });
    }
    ui.widget.apply({ type: 'reasoning.delta', id, content: { type: 'text', text: String(payload['text'] ?? '') } });
  } else if (event === 'tool') {
    const id = `tool-${widgetToolSeq++}`;
    const ok = payload['ok'] === true;
    ui.widget.apply({
      type: 'tool.start',
      id,
      name: String(payload['name'] ?? 'Tool call'),
      input: JSON.stringify(payload['arguments'] ?? {}, null, 2),
    });
    ui.widget.apply({
      type: 'tool.end',
      id,
      status: ok ? 'complete' : 'error',
      output: ok && payload['result'] !== undefined
        ? [{ type: 'text', text: JSON.stringify(payload['result'], null, 2) }]
        : undefined,
      error: ok ? undefined : String(payload['error'] ?? 'Tool call failed'),
    });
  } else if (event === 'done' && promptId) {
    if (widgetTextMessages.delete(promptId)) ui.widget.apply({ type: 'message.end', id: promptId });
    const reasoningId = `${promptId}:reasoning`;
    if (widgetReasoningMessages.delete(reasoningId)) ui.widget.apply({ type: 'reasoning.end', id: reasoningId });
    const failed = payload['stopReason'] === 'error';
    ui.widget.apply(failed
      ? { type: 'run.error', error: String(payload['error'] ?? 'Agent run failed') }
      : { type: 'run.end' });
    if (widgetPromptId === promptId) widgetPromptId = undefined;
  } else if (event === 'closed') onWidgetClosed(String(payload['reason'] ?? 'closed'));
}

function onWidgetClosed(reason: string): void {
  widgetRef = undefined;
  widgetPromptId = undefined;
  widgetTextMessages.clear();
  widgetReasoningMessages.clear();
  const ui = overlay();
  ui.widget.reset();
  ui.widget.notice(`Detached: ${reason}`);
}

// --- boot ------------------------------------------------------------------

injectProvider();
handlePairingLink();

// Only the top frame gets a widget: a floating panel per iframe would be noise,
// and an iframe is not where a user expects to grant page-wide capabilities.
if (window.top === window && location.pathname !== '/pair') {
  const start = () => overlay().widget.show();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
