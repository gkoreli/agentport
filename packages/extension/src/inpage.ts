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

import type { AgentConnectRequest, SiteTool } from '@agentport/client';
import type { ToolDefinition } from '@agentport/protocol';
import {
  ENVELOPE,
  TO_PAGE,
  TO_WALLET,
  isRecord,
  type PageEnvelope,
  type PageInbound,
  type PageOutbound,
} from './bridge.js';

// Handed over on the injecting <script> tag. Same-document scoping only — the
// page can read it, and reading it buys nothing: see the note in bridge.ts.
const CHANNEL = (document.currentScript as HTMLScriptElement | null)?.dataset['channel'] ?? '';

type Listener = (payload: never) => void;

interface PageSessionEvents {
  delta: { promptId: string; text: string };
  thought: { promptId: string; text: string };
  done: { promptId: string; stopReason: string; error?: string };
  tool: { name: string; arguments: Record<string, unknown>; ok: boolean; result?: unknown; error?: string };
  closed: { reason: string };
}

/** The page's view of a session. Structurally the useful part of
 *  `AgentSession`, minus everything that would require key or socket access. */
export interface PageAgentSession {
  readonly id: string;
  readonly info: { agentName: string; runtime: string };
  readonly grant: { tools: ToolDefinition[]; expiresAt: number };
  readonly closed: boolean;
  prompt(text: string, context?: Record<string, unknown>): Promise<string>;
  cancel(promptId: string): void;
  close(reason?: string): void;
  on<K extends keyof PageSessionEvents>(event: K, listener: (value: PageSessionEvents[K]) => void): () => void;
}

class PageSession implements PageAgentSession {
  readonly id: string;
  readonly info: { agentName: string; runtime: string };
  readonly grant: { tools: ToolDefinition[]; expiresAt: number };

  readonly tools = new Map<string, SiteTool>();
  #listeners = new Map<string, Set<Listener>>();
  #turns = new Set<{ reject: (err: Error) => void }>();
  #closed = false;

  constructor(init: {
    ref: string;
    info: { agentName: string; runtime: string };
    grant: { tools: ToolDefinition[]; expiresAt: number };
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
    if (this.#closed) return Promise.reject(new Error('session is closed'));
    return new Promise<string>((resolve, reject) => {
      const turn = { reject };
      this.#turns.add(turn);
      post<string>({ t: 'prompt', rid: rid('r_'), ref: this.id, text, ...(context ? { context } : {}) }).then(
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
  }

  cancel(promptId: string): void {
    send({ t: 'prompt.cancel', ref: this.id, promptId });
  }

  close(reason = 'user_closed'): void {
    if (this.#closed) return;
    send({ t: 'close', ref: this.id, reason });
    this.finish(reason);
  }

  on<K extends keyof PageSessionEvents>(event: K, listener: (value: PageSessionEvents[K]) => void): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as Listener);
    return () => set!.delete(listener as Listener);
  }

  emit<K extends keyof PageSessionEvents>(event: K, value: PageSessionEvents[K]): void {
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
      case 'tool':
        this.emit('tool', payload as PageSessionEvents['tool']);
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
  return prefix + Math.random().toString(36).slice(2, 12);
}

function send(body: PageOutbound): void {
  if (!CHANNEL) throw new Error('AgentPort provider was loaded without a channel');
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
    readonly reason: string,
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
      waiter?.reject(new ProviderRejected(body.reason));
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
  const tool = session?.tools.get(call.name) ?? webmcpTools.get(call.name);
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
  info: { agentName: string; runtime: string };
  grant: { tools: ToolDefinition[]; expiresAt: number };
}

const provider = {
  version: '0.0.1',

  async isAvailable(): Promise<boolean> {
    const value = await post<boolean>({ t: 'available', rid: rid('r_') });
    return value === true;
  },

  async connect(request: AgentConnectRequest): Promise<PageAgentSession> {
    const tools = (request.tools ?? []) as SiteTool[];
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
};

const target = globalThis as unknown as { navigator?: object; agent?: unknown };
if (target.navigator) {
  Object.defineProperty(target.navigator, 'agent', { value: provider, configurable: true, enumerable: false });
}
target.agent = provider;
window.dispatchEvent(new Event('agent#initialized'));

// ---------------------------------------------------------------------------
// WebMCP interop
//
// `navigator.modelContext` is the site telling *some* agent what it can do. If
// the site already speaks it, we would rather lend the agent those tools than
// our generic DOM ones — the site's own tools carry intent, ours only carry
// pixels. Registrations live in the page world, so harvesting has to happen
// here and calls have to execute here; the content script only sees names,
// descriptions and schemas.
// ---------------------------------------------------------------------------

const webmcpTools = new Map<string, SiteTool>();

interface WebMcpToolLike {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  execute?: unknown;
  annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown };
}

function adoptWebMcpTools(list: unknown): void {
  if (!Array.isArray(list)) return;
  for (const entry of list as WebMcpToolLike[]) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.execute !== 'function') continue;
    const execute = entry.execute as (args: Record<string, unknown>) => unknown;
    const annotations = isRecord(entry.annotations) ? entry.annotations : {};
    const readOnly = annotations['readOnlyHint'] === true;
    webmcpTools.set(entry.name, {
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : entry.name,
      inputSchema: isRecord(entry.inputSchema) ? entry.inputSchema : { type: 'object' },
      // A WebMCP tool the site says is read-only still mutates nothing we can
      // verify, so anything not explicitly read-only is gated.
      ...(readOnly ? {} : { requiresApproval: true }),
      handler: (args) => execute(args),
    });
  }
  publishWebMcpTools();
}

function publishWebMcpTools(): void {
  send({
    t: 'webmcp.tools',
    tools: [...webmcpTools.values()].map(({ handler: _handler, ...definition }) => definition),
  });
}

interface ModelContextLike {
  provideContext?: (context: { tools?: unknown }) => unknown;
  registerTool?: (tool: unknown) => unknown;
}

function observeModelContext(): void {
  const nav = navigator as Navigator & { modelContext?: ModelContextLike };
  const existing = nav.modelContext;

  if (existing && typeof existing === 'object') {
    // A real implementation is present: wrap it, never replace it. We only want
    // to see what the site registers.
    const provideContext = existing.provideContext;
    if (typeof provideContext === 'function') {
      existing.provideContext = function (this: unknown, context: { tools?: unknown }) {
        adoptWebMcpTools(context?.tools);
        return provideContext.call(this, context);
      };
    }
    const registerTool = existing.registerTool;
    if (typeof registerTool === 'function') {
      existing.registerTool = function (this: unknown, tool: unknown) {
        adoptWebMcpTools([tool]);
        return registerTool.call(this, tool);
      };
    }
    return;
  }

  // No implementation: stand one up so WebMCP-aware sites get AgentPort for
  // free. Degrades to nothing if the browser later ships its own — this shim
  // is `configurable`.
  const shim: ModelContextLike = {
    provideContext(context) {
      webmcpTools.clear();
      adoptWebMcpTools(context?.tools);
    },
    registerTool(tool) {
      adoptWebMcpTools([tool]);
      const name = isRecord(tool) ? String(tool['name']) : '';
      return { unregister: () => { webmcpTools.delete(name); publishWebMcpTools(); } };
    },
  };
  Object.defineProperty(navigator, 'modelContext', { value: shim, configurable: true, enumerable: false });
}

observeModelContext();
