/**
 * The two boundaries this extension exists to create, and the vocabulary that
 * crosses them.
 *
 *   [PAGE]      window.postMessage      [CONTENT]     chrome.runtime.Port     [SW]
 *   untrusted  ------------------->  isolated world  ------------------->  key custody
 *
 * The page boundary is hostile by construction: any script on the site can
 * `window.postMessage` whatever it likes, and the in-page provider itself can
 * be monkey-patched by the site before we ever run. So nothing arriving from
 * the page is a fact. It is a *request*, carrying only:
 *
 *   - a connection request (tools the site is lending),
 *   - a prompt for a session the content script already handed it,
 *   - a result for a tool call the content script actually dispatched to it.
 *
 * Everything else — identity, session ids, grants, approvals — is minted on the
 * trusted side and never accepted back from the page. Session references handed
 * to the page are opaque and are checked for channel ownership on every use, so
 * a compromised page cannot reach a session belonging to another frame or to
 * the extension's own fallback widget (AGENTS.md invariant 3, applied one layer
 * further out than the relay).
 */

import { isPromptId, randomId, type ToolDefinition } from '@agentport/protocol';

/** Envelope discriminator. Present on every frame in both directions. */
export const ENVELOPE = 'agentport/ext/1';

/** Page → content script. */
export const TO_WALLET = 'page->wallet';
/** Content script → page. */
export const TO_PAGE = 'wallet->page';

// --- limits ----------------------------------------------------------------
//
// A page can call `connect()` in a loop with megabyte tool descriptions. The
// content script is the only thing between that and the service worker's single
// socket, so bounds live here and are enforced on the trusted side.

export const LIMITS = {
  tools: 64,
  toolNameLength: 128,
  descriptionLength: 4096,
  textLength: 128 * 1024,
  jsonBytes: 256 * 1024,
  sessionsPerChannel: 4,
  pendingCallsPerSession: 64,
} as const;

// ---------------------------------------------------------------------------
// Page ⇄ content script
// ---------------------------------------------------------------------------

export interface PageConnectRequest {
  name: string;
  route?: string;
  context?: Record<string, unknown>;
  tools: ToolDefinition[];
  alwaysAsk?: string[];
  ttlMs?: number;
}

export type PageOutbound =
  | { t: 'available'; rid: string }
  | { t: 'connect'; rid: string; request: PageConnectRequest }
  /** Reclaim a session this origin+surface already holds, after a navigation. */
  | { t: 'resume'; rid: string; request: PageConnectRequest }
  | { t: 'history'; rid: string; ref: string }
  | { t: 'prompt'; rid: string; ref: string; promptId: string; text: string; context?: Record<string, unknown> }
  | { t: 'prompt.cancel'; ref: string; promptId: string }
  | { t: 'tool.result'; callId: string; ok: boolean; result?: unknown; error?: string }
  | { t: 'close'; ref: string; reason?: string }
  /** WebMCP interop: definitions harvested from the page-world modelContext. */
  | { t: 'webmcp.tools'; tools: ToolDefinition[] };

export type PageInbound =
  | { t: 'ready' }
  | { t: 'ok'; rid: string; value?: unknown }
  | { t: 'err'; rid: string; reason: ExtensionProviderErrorReason; message: string }
  | { t: 'tool.call'; callId: string; ref: string; name: string; arguments: Record<string, unknown> }
  | { t: 'event'; ref: string; event: string; payload: unknown };

export interface PageEnvelope<T> {
  e: typeof ENVELOPE;
  dir: typeof TO_WALLET | typeof TO_PAGE;
  /** Minted by the content script at document_start and echoed by the page.
   *  Not a secret — the page can read it — it only separates our traffic from
   *  every other postMessage on the page. Authority comes from ownership
   *  checks, never from this id. */
  channel: string;
  body: T;
}

// ---------------------------------------------------------------------------
// Content script ⇄ service worker
// ---------------------------------------------------------------------------

/** Where a connection request came from. Decides who may answer tool calls. */
export type Origin = 'page' | 'widget';

export interface SessionDescriptor {
  ref: string;
  agentName: string;
  runtime: string;
  tools: string[];
  expiresAt: number;
}

export interface AgentRow {
  agent: string;
  name: string;
  runtime: string;
  location?: string;
  online: boolean;
}

/** Reasons the extension provider may return across the page boundary. */
export type ExtensionProviderErrorReason =
  | 'no_agents'
  | 'cancelled'
  | 'denied'
  | 'error'
  | 'extension_updating';

export type ContentToWorker =
  | { t: 'hello'; version: string }
  | { t: 'pair.link'; rid: string; code: string }
  | { t: 'connect'; rid: string; from: Origin; request: PageConnectRequest }
  | { t: 'resume'; rid: string; from: Origin; request: PageConnectRequest }
  | { t: 'history'; rid: string; ref: string }
  | { t: 'prompt'; rid: string; ref: string; promptId: string; text: string; context?: Record<string, unknown> }
  | { t: 'prompt.cancel'; ref: string; promptId: string }
  | { t: 'tool.result'; ref: string; callId: string; ok: boolean; result?: unknown; error?: string }
  | { t: 'close'; ref: string; reason?: string }
  | { t: 'status'; rid: string };

export type WorkerToContent =
  | { t: 'hello'; version: string; compatible: boolean }
  | { t: 'ok'; rid: string; value?: unknown }
  | { t: 'err'; rid: string; reason: ExtensionProviderErrorReason; message: string }
  | { t: 'tool.call'; ref: string; callId: string; name: string; arguments: Record<string, unknown> }
  | { t: 'event'; ref: string; event: string; payload: unknown };

// ---------------------------------------------------------------------------
// Consent window ⇄ service worker
//
// Consent and approvals render in EXTENSION chrome — a popup window on the
// extension origin — never in page DOM (ADR-009). The page can cover an
// overlay and pixel-perfectly fake one; it cannot draw into a browser window
// it does not own. The window learns which question it is answering from the
// worker, keyed by an id minted in the worker; the origin it displays came
// from `port.sender`, never from the page.
// ---------------------------------------------------------------------------

export type ConsentPayload =
  | { kind: 'connect'; origin: string; request: PageConnectRequest; agents: AgentRow[] }
  | { kind: 'pair'; agent: { name: string; runtime: string; location?: string } }
  | {
      kind: 'approve';
      origin: string;
      agentName: string;
      summary: string;
      call?: { name: string; arguments: Record<string, unknown> };
    };

export type ConsentToWorker =
  | { t: 'consent.get'; rid: string; id: string }
  /** connect → the chosen agent pubkey or null; approve → boolean. */
  | { t: 'consent.answer'; id: string; value: unknown };

export type WorkerToConsent =
  | { t: 'ok'; rid: string; value?: unknown }
  | { t: 'err'; rid: string; message: string };

/** Popup ⇄ service worker. Extension-origin only; still typed, still checked. */
export type PopupToWorker =
  | { t: 'identity' }
  | { t: 'identity.create' }
  | { t: 'identity.import'; secretKey: string }
  | { t: 'agents' }
  | { t: 'pair.claim'; code: string }
  | { t: 'pair.approve'; code: string; name?: string }
  | { t: 'relay.set'; url: string }
  | { t: 'sessions' };

// ---------------------------------------------------------------------------
// Validation
//
// Every one of these runs on the trusted side of a boundary. They rebuild the
// value from scratch rather than narrowing it in place: a structured-cloned
// object from the page may carry extra fields, getters are already gone, but
// passing the same object onward would let unvalidated keys ride along into a
// frame the relay forwards to the user's own machine.
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

/** JSON round-trip with a size ceiling: drops functions, cycles and prototypes. */
export function plainJson(value: unknown, maxBytes = LIMITS.jsonBytes): unknown {
  let text: string;
  try {
    text = JSON.stringify(value ?? null);
  } catch {
    return null;
  }
  if (text.length > maxBytes) return null;
  return JSON.parse(text) as unknown;
}

export function sanitizeToolDefinition(value: unknown): ToolDefinition | undefined {
  if (!isRecord(value)) return undefined;
  const name = str(value['name'], LIMITS.toolNameLength);
  if (!name || !/^[A-Za-z0-9_.\-]+$/.test(name)) return undefined;
  const description = str(value['description'], LIMITS.descriptionLength) ?? name;
  const schema = plainJson(value['inputSchema']);
  return {
    name,
    description,
    inputSchema: isRecord(schema) ? schema : { type: 'object' },
    ...(value['requiresApproval'] === true ? { requiresApproval: true } : {}),
  };
}

export function sanitizeTools(value: unknown): ToolDefinition[] {
  if (!Array.isArray(value)) return [];
  const out: ToolDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of value.slice(0, LIMITS.tools)) {
    const tool = sanitizeToolDefinition(entry);
    if (!tool || seen.has(tool.name)) continue;
    seen.add(tool.name);
    out.push(tool);
  }
  return out;
}

export function sanitizeConnectRequest(value: unknown): PageConnectRequest | undefined {
  if (!isRecord(value)) return undefined;
  const tools = sanitizeTools(value['tools']);
  const name = str(value['name'], 128) ?? 'This site';
  const route = str(value['route'], 2048);
  const context = plainJson(value['context']);
  const alwaysAsk = Array.isArray(value['alwaysAsk'])
    ? value['alwaysAsk']
        .filter((n): n is string => typeof n === 'string')
        .filter((n) => tools.some((tool) => tool.name === n))
        .slice(0, LIMITS.tools)
    : [];
  const ttl = typeof value['ttlMs'] === 'number' && Number.isFinite(value['ttlMs']) ? value['ttlMs'] : undefined;
  return {
    name,
    tools,
    alwaysAsk,
    ...(route ? { route } : {}),
    ...(isRecord(context) ? { context } : {}),
    ...(ttl ? { ttlMs: Math.min(Math.max(ttl, 60_000), 24 * 60 * 60 * 1000) } : {}),
  };
}

/** Shape check for anything the page posts at us. Returns undefined on refusal. */
export function readPageOutbound(value: unknown): PageOutbound | undefined {
  if (!isRecord(value)) return undefined;
  const t = value['t'];
  switch (t) {
    case 'available': {
      const rid = str(value['rid'], 64);
      return rid ? { t, rid } : undefined;
    }
    case 'connect': {
      const rid = str(value['rid'], 64);
      const request = sanitizeConnectRequest(value['request']);
      return rid && request ? { t, rid, request } : undefined;
    }
    case 'resume': {
      // Same shape as connect, and deliberately the same sanitizer: a reclaim
      // re-declares the surface's tools, so it is exactly as much of an
      // authority statement as the original request and gets exactly as much
      // scrutiny. The worker still decides whether the origin may reclaim.
      const rid = str(value['rid'], 64);
      const request = sanitizeConnectRequest(value['request']);
      return rid && request ? { t, rid, request } : undefined;
    }
    case 'history': {
      const rid = str(value['rid'], 64);
      const ref = str(value['ref'], 64);
      return rid && ref ? { t, rid, ref } : undefined;
    }
    case 'prompt': {
      const rid = str(value['rid'], 64);
      const ref = str(value['ref'], 64);
      const promptId = str(value['promptId'], 64);
      const text = str(value['text'], LIMITS.textLength);
      if (!rid || !ref || !isPromptId(promptId) || text === undefined) return undefined;
      const context = plainJson(value['context']);
      return { t, rid, ref, promptId, text, ...(isRecord(context) ? { context } : {}) };
    }
    case 'prompt.cancel': {
      const ref = str(value['ref'], 64);
      const promptId = str(value['promptId'], 64);
      return ref && isPromptId(promptId) ? { t, ref, promptId } : undefined;
    }
    case 'tool.result': {
      const callId = str(value['callId'], 64);
      if (!callId || typeof value['ok'] !== 'boolean') return undefined;
      return value['ok']
        ? { t, callId, ok: true, result: plainJson(value['result']) }
        : { t, callId, ok: false, error: str(value['error'], 2048) ?? 'tool failed' };
    }
    case 'close': {
      const ref = str(value['ref'], 64);
      return ref ? { t, ref, reason: str(value['reason'], 128) ?? 'page_closed' } : undefined;
    }
    case 'webmcp.tools':
      return { t, tools: sanitizeTools(value['tools']) };
    default:
      // Exhaustiveness, enforced by the compiler rather than by review. `t` is
      // unknown here, so the assignment only narrows to `never` once every
      // PageOutbound member above has a case. Adding a member to the union and
      // forgetting to validate it is then a type error — not a message the
      // content script silently drops with no reply, leaving the page's promise
      // to hang forever. `resume` and `history` were exactly that for their
      // whole existence: declared, handled in content.ts, never validated.
      return undefined;
  }
}

/**
 * Every message type `readPageOutbound` validates. `satisfies` proves each name
 * is real; `UnvalidatedPageOutbound` proves none is missing. Adding a member to
 * PageOutbound and forgetting to validate it is then a type error rather than a
 * message the content script silently drops with no reply, leaving the page's
 * promise to hang forever — which is what `resume` and `history` were for their
 * whole existence: declared in the union, handled in content.ts, never
 * validated, so navigator.agent.resume() and session.history() never settled
 * through the extension at all.
 */
const VALIDATED = [
  'available',
  'connect',
  'resume',
  'history',
  'prompt',
  'prompt.cancel',
  'tool.result',
  'close',
  'webmcp.tools',
] as const satisfies readonly PageOutbound['t'][];

type UnvalidatedPageOutbound = Exclude<PageOutbound['t'], (typeof VALIDATED)[number]>;
const _everyPageMessageIsValidated: UnvalidatedPageOutbound[] = [];
void _everyPageMessageIsValidated;

/** Ids minted on the trusted side. Never derived from anything the page sent. */
export function mintId(prefix: string): string {
  return randomId(prefix);
}
