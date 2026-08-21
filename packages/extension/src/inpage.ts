/**
 * The page-world half: defines `navigator.agent`.
 *
 * This file is the *only* part of the extension the site can touch, and it is
 * deliberately powerless. It holds no key, no socket, and no session state the
 * trusted side relies on. Everything it knows it learned from the content
 * script, and everything it asks for is re-validated there. Treat this file as
 * site code that happens to ship with us: if the page rewrites it, the worst
 * outcome is that the *page* lies to itself.
 *
 * Mirrors `installProvider` in @agentport/client — same `navigator.agent`
 * shape, same `agent#initialized` event — so a site written against the
 * in-page demo wallet works unmodified against the extension.
 */

import {
  createWebMcpRegistry,
  type AgentConnectRequest,
  type AgentProvider,
  type AgentSessionHandle,
  type ModelContextLike,
  type PromptRequest,
  type SessionEvents,
  type SiteTool,
} from '@agentport/client';
import {
  ID_PATTERN,
  MAX_ANSWER_CHARS,
  MAX_FORM_FIELDS,
  createLogger,
  randomId,
  type HistoryEntry,
  type ToolDefinition,
} from '@agentport/protocol';
import {
  ENVELOPE,
  PAGE_CHANNEL,
  TO_PAGE,
  TO_WALLET,
  isRecord,
  sanitizeFormFields,
  sanitizePlanSteps,
  type PageEnvelope,
  type PageInbound,
  type PageOutbound,
  type ExtensionProviderErrorReason,
} from './bridge.js';
import { AGENTPORT_VERSION } from './version.js';

/** Bump whenever the injected provider or page-session surface changes shape. */
export const CONTRACT_REVISION = 1;

// A constant, because this file is injected by browser registration on
// enabled origins (`enablement.ts`) and a registered script has no <script>
// tag to carry a per-document value. Traffic separation only — it never
// carried authority: see the note on PAGE_CHANNEL in bridge.ts.
const CHANNEL = PAGE_CHANNEL;

type Listener = (payload: never) => void;

/** The page's view of a session. Structurally the useful part of
 *  `AgentSession`, minus everything that would require key or socket access.
 *
 *  `info` is deliberately generic (ADR-009): `agentName` is a label like
 *  "Personal agent", never the user's real agent name, and `alias` is stable
 *  for THIS origin only — two sites comparing aliases learn nothing. */
export interface PageAgentSession extends AgentSessionHandle {
  readonly id: string;
  readonly info: { agentName: string; runtime: string; ownTools: boolean; alias?: string };
  readonly grant: { tools: ToolDefinition[]; alwaysAsk: string[]; expiresAt: number };
}

// DEFERRED (v7): prompt image blocks do not cross the extension's page
// boundary yet. The bridge admits no `blocks` field from page world, so a
// page cannot reach the silent-drop failure the AgentSessionHandle contract
// forbids — carrying them here means widening the bridge validator and the
// worker's startPrompt call in the same change, not widening this class alone.
class PageSession implements PageAgentSession {
  readonly id: string;
  readonly info: { agentName: string; runtime: string; ownTools: boolean; alias?: string };
  readonly grant: { tools: ToolDefinition[]; alwaysAsk: string[]; expiresAt: number };

  readonly tools = new Map<string, SiteTool>();
  #listeners = new Map<string, Set<Listener>>();
  #turns = new Set<{ reject: (err: Error) => void }>();
  #closed = false;

  constructor(init: {
    ref: string;
    info: { agentName: string; runtime: string; ownTools: boolean; alias?: string };
    grant: { tools: ToolDefinition[]; alwaysAsk: string[]; expiresAt: number };
    tools: SiteTool[];
  }) {
    this.id = init.ref;
    this.info = init.info;
    this.grant = init.grant;
    for (const tool of init.tools) this.tools.set(tool.name, tool);
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * The turn's full text comes back from the wallet, not from summing the
   * deltas we happened to see: the page is not the authority on its own
   * transcript. Prompt ids are minted wallet-side and surface on `delta` /
   * `done`, which is where `cancel` gets its id from.
   */
  prompt(text: string, context?: Record<string, unknown>): Promise<string> {
    return this.startPrompt(text, context).result;
  }

  /** Same contract as AgentSession.startPrompt: the id is known before the
   *  first token, minted here and honoured by the wallet, so renderers can
   *  show a truthful Stop control and correlate every event. */
  startPrompt(text: string, context?: Record<string, unknown>): PromptRequest {
    const promptId = rid('p_');
    if (this.#closed) return { id: promptId, result: Promise.reject(new Error('session is closed')) };
    const result = new Promise<string>((resolve, reject) => {
      const turn = { reject };
      this.#turns.add(turn);
      post<string>({ t: 'prompt', rid: rid('r_'), ref: this.id, promptId, text, ...(context ? { context } : {}) }).then(
        (full) => {
          this.#turns.delete(turn);
          resolve(typeof full === 'string' ? full : '');
        },
        (err: unknown) => {
          this.#turns.delete(turn);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
    return { id: promptId, result };
  }

  cancel(promptId: string): void {
    send({ t: 'prompt.cancel', ref: this.id, promptId });
  }

  /**
   * Answer a question the agent asked (ADR-024). Omitting `values` — or
   * passing none — is a SKIP, which is a real answer meaning "proceed without
   * one", not an error and not a cancellation.
   *
   * The bounds checked here are ERGONOMICS, not security: this file is the one
   * part of the extension the site can rewrite, so the authoritative copy of
   * every check below runs in the content script (`sanitizeAnswerFields`). The
   * reason to duplicate them is that the trusted side has no way to answer a
   * `void` method — it can only drop the message — and a caller who quietly
   * loses an answer learns nothing until the agent's question times out
   * minutes later. Throwing here tells an honest caller immediately, in their
   * own stack, exactly as `startPrompt` does for an over-long prompt.
   */
  answer(askId: string, values?: Record<string, string>): void {
    if (!ID_PATTERN.test(askId)) throw new Error('invalid ask id');
    const entries = Object.entries(values ?? {});
    if (entries.length === 0) {
      send({ t: 'answer', ref: this.id, askId });
      return;
    }
    if (entries.length > MAX_FORM_FIELDS) {
      throw new Error(`an answer may carry at most ${MAX_FORM_FIELDS} fields`);
    }
    for (const [key, value] of entries) {
      if (!ID_PATTERN.test(key)) throw new Error(`answer field name is not a valid key: ${key}`);
      // Rejected, never truncated: a shortened answer would be delivered to
      // the agent as words the user did not say, with the user's authority on
      // it. Same rule as a prompt that exceeds the wire bound.
      if (typeof value !== 'string' || value.length > MAX_ANSWER_CHARS) {
        throw new Error(`answer for "${key}" exceeds the protocol limit of ${MAX_ANSWER_CHARS} characters`);
      }
    }
    send({ t: 'answer', ref: this.id, askId, values: entries.map(([key, value]) => ({ key, value })) });
  }

  /** The conversation, replayed from the agent's own store via the wallet. */
  history(): Promise<HistoryEntry[]> {
    return post<HistoryEntry[]>({ t: 'history', rid: rid('r_'), ref: this.id }).then((entries) =>
      Array.isArray(entries) ? entries : [],
    );
  }

  close(reason = 'user_closed'): void {
    if (this.#closed) return;
    send({ t: 'close', ref: this.id, reason });
    this.finish(reason);
  }

  on<K extends keyof SessionEvents>(event: K, listener: (value: SessionEvents[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as Listener);
    return () => set!.delete(listener as Listener);
  }

  emit<K extends keyof SessionEvents>(event: K, value: SessionEvents[K]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) (listener as (v: unknown) => void)(value);
  }

  /** @internal — streaming events forwarded by the content script. */
  handle(event: string, payload: unknown): void {
    if (!isRecord(payload)) return;
    switch (event) {
      case 'delta':
        this.emit('delta', { promptId: String(payload['promptId']), text: String(payload['text'] ?? '') });
        return;
      case 'thought':
        this.emit('thought', { promptId: String(payload['promptId']), text: String(payload['text'] ?? '') });
        return;
      case 'done':
        this.emit('done', {
          promptId: String(payload['promptId']),
          stopReason: String(payload['stopReason'] ?? 'end_turn'),
          error: payload['error'] as string | undefined,
        });
        return;
      case 'plan': {
        // Snapshot, never an append: the site replaces its checklist with this
        // one. A malformed snapshot is dropped whole rather than half-rendered
        // — see `sanitizePlanSteps`, which is the same validator the
        // extension's own widget renders through.
        const steps = sanitizePlanSteps(payload['steps']);
        if (!steps) return;
        this.emit('plan', { promptId: String(payload['promptId']), steps });
        return;
      }
      case 'reattached':
        // The socket dropped and the attachment came back on fresh sealing
        // keys. The site keeps its handle — that is the point — but every
        // prompt and history request in flight lost its answer, so it is told.
        this.emit('reattached', typeof payload['verify'] === 'string' ? { verify: payload['verify'] } : {});
        return;
      case 'ask': {
        // The agent is asking its user something. Rebuilt rather than
        // forwarded, and dropped whole if it does not rebuild: a question is a
        // form a human reads before committing their own authority to the
        // answer, so half of one is worse than none — the user would answer a
        // question the agent did not ask.
        const id = payload['id'];
        const message = payload['message'];
        const fields = sanitizeFormFields(payload['fields']);
        if (typeof id !== 'string' || typeof message !== 'string' || !fields) return;
        this.emit('ask', { id, message, fields });
        return;
      }
      case 'tool':
        this.emit('tool', payload as SessionEvents['tool']);
        return;
      case 'closed':
        this.finish(String(payload['reason'] ?? 'closed'));
        return;
      default:
        return;
    }
  }

  finish(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const turn of this.#turns) turn.reject(new Error(`session closed: ${reason}`));
    this.#turns.clear();
    this.emit('closed', { reason });
  }
}

// --- transport -------------------------------------------------------------

const pending = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void }>();
const sessions = new Map<string, PageSession>();

function rid(prefix: string): string {
  return randomId(prefix);
}

function send(body: PageOutbound): void {
  const envelope: PageEnvelope<PageOutbound> = { e: ENVELOPE, dir: TO_WALLET, channel: CHANNEL, body };
  window.postMessage(envelope, window.origin === 'null' ? '*' : window.origin);
}

function post<T>(body: Extract<PageOutbound, { rid: string }>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    pending.set(body.rid, { resolve: resolve as (value: unknown) => void, reject });
    send(body);
  });
}

/** Rejection reasons match `ProviderRejected` in @agentport/client. */
class ProviderRejected extends Error {
  constructor(
    readonly reason: ExtensionProviderErrorReason,
    detail?: string,
  ) {
    // The worker's detail says WHICH denial this was ("no agents paired yet",
    // "the user declined the capability grant", …). Dropping it collapses
    // every failure into one unactionable string.
    super(detail ? `agent connection ${reason} — ${detail}` : `agent connection ${reason}`);
    this.name = 'ProviderRejected';
  }
}

function onInbound(body: PageInbound): void {
  switch (body.t) {
    case 'ready':
      return;
    case 'ok': {
      const waiter = pending.get(body.rid);
      pending.delete(body.rid);
      waiter?.resolve(body.value);
      return;
    }
    case 'err': {
      const waiter = pending.get(body.rid);
      pending.delete(body.rid);
      waiter?.reject(new ProviderRejected(body.reason, body.message));
      return;
    }
    case 'tool.call': {
      void runTool(body);
      return;
    }
    case 'event': {
      sessions.get(body.ref)?.handle(body.event, body.payload);
      return;
    }
    default:
      return;
  }
}

async function runTool(call: Extract<PageInbound, { t: 'tool.call' }>): Promise<void> {
  const session = sessions.get(call.ref);
  const tool = session?.tools.get(call.name) ?? webmcp.get(call.name);
  if (!tool) {
    send({ t: 'tool.result', callId: call.callId, ok: false, error: `unknown tool ${call.name}` });
    return;
  }
  try {
    const result = await tool.handler(call.arguments ?? {});
    send({ t: 'tool.result', callId: call.callId, ok: true, result });
  } catch (err) {
    send({ t: 'tool.result', callId: call.callId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  // Only same-window traffic. A cross-origin iframe posting into us is not the
  // wallet, and neither is anything without our channel id.
  if (event.source !== window) return;
  const data: unknown = event.data;
  if (!isRecord(data) || data['e'] !== ENVELOPE || data['dir'] !== TO_PAGE || data['channel'] !== CHANNEL) return;
  if (!isRecord(data['body'])) return;
  onInbound(data['body'] as PageInbound);
});

// --- provider --------------------------------------------------------------

interface ConnectResult {
  ref: string;
  info: { agentName: string; runtime: string; ownTools: boolean; alias?: string };
  grant: { tools: ToolDefinition[]; alwaysAsk: string[]; expiresAt: number };
}

const provider = {
  version: AGENTPORT_VERSION,
  contract: CONTRACT_REVISION,

  async isAvailable(): Promise<boolean> {
    const value = await post<boolean>({ t: 'available', rid: rid('r_') });
    return value === true;
  },

  async connect(request: AgentConnectRequest): Promise<PageAgentSession> {
    const tools = mergeWebMcpTools((request.tools ?? []) as SiteTool[]);
    const result = await post<ConnectResult>({
      t: 'connect',
      rid: rid('r_'),
      request: {
        name: request.name,
        ...(request.route ? { route: request.route } : {}),
        ...(request.context ? { context: request.context } : {}),
        // Handlers stay here; only definitions cross the boundary.
        tools: tools.map(({ handler: _handler, ...definition }) => definition),
        ...(request.alwaysAsk ? { alwaysAsk: request.alwaysAsk } : {}),
        ...(request.ttlMs ? { ttlMs: request.ttlMs } : {}),
      },
    });
    const session = new PageSession({ ref: result.ref, info: result.info, grant: result.grant, tools });
    sessions.set(result.ref, session);
    session.on('closed', () => sessions.delete(result.ref));
    return session;
  },

  /**
   * Reclaim the session this origin+surface already holds, if the wallet kept
   * one alive across a navigation. No picker, no consent — the original grant
   * never lapsed. Returns null when there is nothing to resume.
   */
  async resume(request: AgentConnectRequest): Promise<PageAgentSession | null> {
    const tools = mergeWebMcpTools((request.tools ?? []) as SiteTool[]);
    const result = await post<ConnectResult | null>({
      t: 'resume',
      rid: rid('r_'),
      request: {
        name: request.name,
        ...(request.route ? { route: request.route } : {}),
        ...(request.context ? { context: request.context } : {}),
        tools: tools.map(({ handler: _handler, ...definition }) => definition),
        ...(request.alwaysAsk ? { alwaysAsk: request.alwaysAsk } : {}),
        ...(request.ttlMs ? { ttlMs: request.ttlMs } : {}),
      },
    });
    if (!result) return null;
    const session = new PageSession({ ref: result.ref, info: result.info, grant: result.grant, tools });
    sessions.set(result.ref, session);
    session.on('closed', () => sessions.delete(result.ref));
    return session;
  },
} satisfies AgentProvider & {
  readonly contract: number;
  resume(request: AgentConnectRequest): Promise<PageAgentSession | null>;
};

export type PageSessionInstance = PageSession;
export type InjectedProvider = typeof provider;

const target = globalThis as unknown as { navigator?: object; agent?: unknown };
if (target.navigator) {
  Object.defineProperty(target.navigator, 'agent', { value: provider, configurable: true, enumerable: false });
}
target.agent = provider;

// ---------------------------------------------------------------------------
// WebMCP interop
//
// `document.modelContext` (formerly `navigator.modelContext`) is the site
// telling *some* agent what it can do. If the site already speaks it, we would
// rather lend the agent those tools than our generic DOM ones — the site's own
// tools carry intent, ours only carry pixels. Registrations live in the page
// world, so harvesting has to happen here and calls have to execute here; the
// content script only sees names, descriptions and schemas.
//
// What WebMCP *is* — the descriptor we accept, the options we forward, the
// rule that a harvested tool always asks — lives in
// `packages/client/src/webmcp.ts`. This is wiring. Two copies of that belief
// is how both harvesters ended up still wrapping a method the draft removed in
// March; there is one copy now, and it is not here.
// ---------------------------------------------------------------------------

const webmcp = createWebMcpRegistry({
  logger: createLogger('extension.webmcp'),
  onChange: () => publishWebMcpTools(),
});

function mergeWebMcpTools(explicit: readonly SiteTool[]): SiteTool[] {
  const merged = new Map<string, SiteTool>();
  for (const tool of webmcp.tools()) merged.set(tool.name, tool);
  for (const tool of explicit) merged.set(tool.name, tool);
  return [...merged.values()];
}

function publishWebMcpTools(): void {
  // This keeps the WORKER's picture of the page current on every toolchange;
  // it does not and cannot reach a live session's grant, which is frozen at
  // attach. TODO(grant.update, protocol v7): when that frame lands, a change
  // arriving here after attachment is what should drive the narrowing (free)
  // or the re-consented widening — never a second reconciliation path here.
  send({
    t: 'webmcp.tools',
    tools: webmcp.tools().map(({ handler: _handler, ...definition }) => definition),
  });
}

function installWebMcp(): void {
  const doc = document as Document & { modelContext?: unknown };
  const nav = navigator as Navigator & { modelContext?: unknown };
  // Chrome moved WebMCP onto document; the navigator spelling remains only as
  // a compatibility fallback for older implementations and site polyfills.
  const existing = isRecord(doc.modelContext)
    ? (doc.modelContext as ModelContextLike)
    : isRecord(nav.modelContext)
      ? (nav.modelContext as ModelContextLike)
      : undefined;

  if (existing) {
    // A real implementation is present: wrap it, never replace it. We only
    // want to see what the site registers, and the browser stays the authority
    // on whether a registration was accepted at all.
    webmcp.observe(existing);
    return;
  }

  // No implementation: stand one up so WebMCP-aware sites get AgentPort on
  // browsers that have not shipped it. It is shaped like the current draft —
  // promise-returning `registerTool(tool, {signal})`, `getTools()`,
  // `toolchange` — and offers none of the methods the draft dropped.
  //
  // Both spellings, one registry: a site written before the getter moved to
  // Document reaches for `navigator.modelContext`, and on a browser with
  // neither there is nothing else for it to find. Configurable, so a later
  // native install can take the name back.
  const shim = webmcp.shim(location.origin);
  Object.defineProperty(document, 'modelContext', { value: shim, configurable: true, enumerable: false });
  Object.defineProperty(navigator, 'modelContext', { value: shim, configurable: true, enumerable: false });
}

installWebMcp();

// Announced last, and that ordering is load-bearing: a site may call
// `navigator.agent.connect()` synchronously from this listener, and connect
// merges the harvested WebMCP tools. Firing before the registry above exists
// would reach it in its temporal dead zone and throw inside the site's own
// handler.
window.dispatchEvent(new Event('agent#initialized'));
