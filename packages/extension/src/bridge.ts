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

import {
  ID_PATTERN,
  MAX_ANSWER_CHARS,
  MAX_FORM_FIELDS,
  MAX_FORM_LABEL_CHARS,
  MAX_FORM_OPTIONS,
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_CHARS,
  isPromptId,
  randomId,
  type AuthorityDomain,
  type FormField,
  type PlanStep,
  type ToolDefinition,
} from '@agentport/protocol';

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

/**
 * One field of an elicitation answer, in the wire's own shape.
 *
 * An ARRAY of pairs rather than a `Record`, all the way to the last hop, for
 * two reasons that both matter at a hostile boundary. `Answer.values` on the
 * wire is already this shape, so there is one dialect instead of two that
 * drift; and an array cannot carry a key like `__proto__` in a position where
 * a rebuild would have to invoke a setter, so every hop rebuilds pairs and
 * only the final call site materialises an object, with `Object.fromEntries`,
 * which defines own properties rather than assigning them.
 */
export interface AnswerField {
  key: string;
  value: string;
}

export type PageOutbound =
  | { t: 'available'; rid: string }
  | { t: 'connect'; rid: string; request: PageConnectRequest }
  /** Reclaim a session this origin+surface already holds, after a navigation. */
  | { t: 'resume'; rid: string; request: PageConnectRequest }
  | { t: 'history'; rid: string; ref: string }
  | { t: 'prompt'; rid: string; ref: string; promptId: string; text: string; context?: Record<string, unknown> }
  | { t: 'prompt.cancel'; ref: string; promptId: string }
  /**
   * The user's answer to a question the AGENT asked (ADR-024).
   *
   * The one page-controlled channel that carries USER AUTHORITY into the
   * agent's reasoning, which is why ADR-024 refuses elicitation on tiers whose
   * answer surface a site can draw — and why this tier is allowed to carry it
   * at all: the extension's surface is one the site cannot draw or read. That
   * makes this the most sensitive member of this union, not the least, so its
   * validator refuses rather than repairs. Absent `values` is a SKIP, which is
   * a real answer meaning "proceed without one", never an error.
   */
  | { t: 'answer'; ref: string; askId: string; values?: AnswerField[] }
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
  /** Already validated by `readPageOutbound`; the ref is re-checked here. */
  | { t: 'answer'; ref: string; askId: string; values?: AnswerField[] }
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
      /**
       * Which authority is being asked about (ADR-023 R4). Carried to the
       * consent window because the window has to SAY it: `summary` is written
       * by the agent and can be made to read like anything, so this is the
       * one line on the card the agent does not author.
       */
      domain: AuthorityDomain;
      summary: string;
      call?: { name: string; arguments: Record<string, unknown> };
    };

/**
 * What each consent kind produces when the user does NOT answer: the window
 * failed to open, they pressed Escape, they closed it, or the worker went
 * away. A missing answer is never a default grant.
 *
 * A mapped type over the kind union, so adding a kind is a COMPILE ERROR here
 * rather than a silent fallthrough. It replaced four copies of
 * `payload.kind === 'connect' ? null : false` living in two files — and every
 * one of them would have been wrong for the next kind, because a ternary
 * shaped around booleans answers `false` to a question whose refusal is not a
 * boolean at all. This is the registry rule from AGENTS.md applied before the
 * registry got a chance to be wrong, rather than after.
 */
export const CONSENT_DENIAL: { readonly [K in ConsentPayload['kind']]: unknown } = {
  /** No agent was chosen. */
  connect: null,
  pair: false,
  approve: false,
};

/** The denial for a kind, so no call site re-derives one. */
export function consentDenial(kind: ConsentPayload['kind']): unknown {
  return CONSENT_DENIAL[kind];
}

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

const PLAN_STATUS = new Set<PlanStep['status']>(['pending', 'active', 'done']);
const PLAN_PRIORITY = new Set<NonNullable<PlanStep['priority']>>(['high', 'medium', 'low']);

/**
 * One plan snapshot, rebuilt for the surface that renders it.
 *
 * All-or-nothing on purpose. A plan is a snapshot of what the agent intends
 * *now* (`Plan` in messages.ts), so dropping a bad step and rendering the rest
 * would show the user a checklist the agent never produced — the same failure
 * the snapshot-not-delta rule exists to prevent. `undefined` means "not
 * renderable"; the caller says so rather than inventing a plan.
 *
 * The bounds are the wire's own (`MAX_PLAN_STEPS`, `MAX_PLAN_STEP_CHARS`), so
 * a snapshot that crossed the sealed channel intact is never refused here for
 * being too big — only one our own plumbing mangled would be.
 */
export function sanitizePlanSteps(value: unknown): PlanStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length > MAX_PLAN_STEPS) return undefined;
  const out: PlanStep[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const text = str(entry['text'], MAX_PLAN_STEP_CHARS);
    if (text === undefined) return undefined;
    const status = entry['status'];
    if (typeof status !== 'string' || !PLAN_STATUS.has(status as PlanStep['status'])) return undefined;
    const priority = entry['priority'];
    if (priority !== undefined && (typeof priority !== 'string' || !PLAN_PRIORITY.has(priority as NonNullable<PlanStep['priority']>))) {
      return undefined;
    }
    out.push({
      text,
      status: status as PlanStep['status'],
      ...(priority === undefined ? {} : { priority: priority as NonNullable<PlanStep['priority']> }),
    });
  }
  return out;
}

/**
 * The fields of one elicitation answer, rebuilt or refused whole.
 *
 * ALL-OR-NOTHING, and this is the rule that matters. Dropping one malformed
 * field and forwarding the rest would deliver, under the user's own authority,
 * an answer the user did not give — the agent is told "your user said this"
 * and everything downstream inherits that provenance, which no later frame can
 * un-attribute. Refusing the whole message leaves the question unanswered,
 * which is a state the protocol already has a meaning for.
 *
 * Bounds are the WIRE's own (`MAX_FORM_FIELDS`, `MAX_ANSWER_CHARS`,
 * `ID_PATTERN`), not numbers chosen here: an answer that would survive this
 * hop and then be refused by the daemon's decoder is a boundary that lies
 * about what it accepts. `undefined` means refused; an empty array is a real
 * value meaning the user submitted nothing, which becomes a skip downstream.
 *
 * Note the empty-string allowance: the wire is `str(0, MAX_ANSWER_CHARS)`, so
 * a blank text field is a legitimate answer and the local `str()` helper —
 * which requires length > 0 — must not be used for it.
 */
export function sanitizeAnswerFields(value: unknown): AnswerField[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FORM_FIELDS) return undefined;
  const out: AnswerField[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const key = entry['key'];
    const answer = entry['value'];
    if (typeof key !== 'string' || !ID_PATTERN.test(key)) return undefined;
    if (typeof answer !== 'string' || answer.length > MAX_ANSWER_CHARS) return undefined;
    // The wire refuses duplicate keys outright rather than picking a winner,
    // and so does this: two answers for one question is not a question we can
    // honestly say the user answered.
    if (seen.has(key)) return undefined;
    seen.add(key);
    out.push({ key, value: answer });
  }
  return out;
}

/**
 * One elicitation's fields, rebuilt for the surface that renders them.
 *
 * The mirror of `sanitizeAnswerFields`, on the way OUT: the question crossing
 * to whatever will draw it. All-or-nothing for the same reason a plan snapshot
 * is — a half-rendered form asks the user something the agent did not ask, and
 * they would answer it with their own authority. Bounds are the wire's own, so
 * a question that crossed the sealed channel intact is never refused here for
 * being too large; only one our own plumbing mangled would be.
 *
 * The refinements are the wire's too, and they are not decoration: `multi`
 * without `options` describes a free-text box that somehow takes several
 * answers, which no renderer can honour, and duplicate options make a choice
 * whose answer is ambiguous.
 */
export function sanitizeFormFields(value: unknown): FormField[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FORM_FIELDS) return undefined;
  const out: FormField[] = [];
  const seenKeys = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const key = entry['key'];
    if (typeof key !== 'string' || !ID_PATTERN.test(key) || seenKeys.has(key)) return undefined;
    seenKeys.add(key);
    const label = str(entry['label'], MAX_FORM_LABEL_CHARS);
    if (label === undefined) return undefined;

    const rawOptions = entry['options'];
    if (rawOptions === undefined) {
      // Free text. `multi` is meaningless without options, so its presence
      // here is a malformed question rather than a permissive one.
      if (entry['multi'] !== undefined) return undefined;
      out.push({ key, label });
      continue;
    }
    if (!Array.isArray(rawOptions) || rawOptions.length === 0 || rawOptions.length > MAX_FORM_OPTIONS) {
      return undefined;
    }
    const options: string[] = [];
    for (const option of rawOptions) {
      const text = str(option, MAX_FORM_LABEL_CHARS);
      if (text === undefined || options.includes(text)) return undefined;
      options.push(text);
    }
    const multi = entry['multi'];
    if (multi !== undefined && typeof multi !== 'boolean') return undefined;
    out.push({ key, label, options, ...(multi === undefined ? {} : { multi }) });
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
    case 'answer': {
      const ref = str(value['ref'], 64);
      const askId = str(value['askId'], 64);
      // The ask id is an opaque handle we hand straight back to the daemon, so
      // it has to satisfy the same pattern the wire will check it against —
      // otherwise a malformed id crosses three hops and dies at a decoder that
      // treats the failure as session-fatal.
      if (!ref || !askId || !ID_PATTERN.test(askId)) return undefined;
      // Absent is a skip. Present-but-unusable is a REFUSAL, never a skip: the
      // two look alike here and mean opposite things to the person the answer
      // is attributed to, so a malformed answer must not quietly become "the
      // user chose not to answer".
      if (value['values'] === undefined) return { t, ref, askId };
      const values = sanitizeAnswerFields(value['values']);
      return values ? { t, ref, askId, values } : undefined;
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
  'answer',
  'tool.result',
  'close',
  'webmcp.tools',
] as const satisfies readonly PageOutbound['t'][];

/**
 * Fails the build naming any PageOutbound member the switch does not validate.
 * The constraint is what does the work: `Exclude<>` narrowing to `never` is the
 * only way to satisfy it, so a missing member produces "Type '"history"' does
 * not satisfy the constraint 'never'". An earlier version of this guard
 * declared `const _: Unvalidated[] = []` instead — vacuous, because an empty
 * array literal is assignable to any array type, so it silently proved nothing.
 */
type AssertNever<T extends never> = T;
type _EveryPageMessageIsValidated = AssertNever<
  Exclude<PageOutbound['t'], (typeof VALIDATED)[number]>
>;

/** Ids minted on the trusted side. Never derived from anything the page sent. */
export function mintId(prefix: string): string {
  return randomId(prefix);
}
