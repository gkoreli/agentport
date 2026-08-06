/**
 * AgentPort wire protocol, version 1.
 *
 * Three parties share one frame vocabulary:
 *
 *   client (a website, via @agentport/client)  <-->  relay  <-->  agent daemon
 *
 * Frames whose type starts with a session-scoped verb carry `s` (the session
 * id) and are forwarded verbatim by the relay. Everything else is relay
 * control traffic and is terminated at the relay.
 *
 * Every frame is defined ONCE, as a strict runtime schema (ADR-019 Gate B §1);
 * the exported TypeScript types are inferred from those schemas, so the
 * validator and the type cannot drift. Unknown frame types and unknown keys
 * reject. Field bounds live in limits.ts with their rationale.
 */

import {
  arr,
  bool,
  en,
  hex,
  hexRange,
  int,
  jsonRecord,
  jsonValue,
  lit,
  obj,
  opt,
  pattern,
  refined,
  str,
  type Infer,
  type Schema,
} from './schema.js';
import {
  AEAD_TAG_BYTES,
  CODE_PATTERN,
  ERROR_CODE_PATTERN,
  ID_PATTERN,
  MAX_AGENTS_LISTED,
  MAX_CIPHERTEXT_BYTES,
  MAX_DESCRIPTION_CHARS,
  MAX_ERROR_CHARS,
  MAX_GRANT_CHARS,
  MAX_HISTORY_ENTRIES,
  MAX_JSON_DEPTH,
  MAX_JSON_LEAF_CHARS,
  MAX_JSON_NODES,
  MAX_MISSED_COUNT,
  MAX_NAME_CHARS,
  MAX_ORIGIN_CHARS,
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_CHARS,
  MAX_REASON_CHARS,
  MAX_ROUTE_CHARS,
  MAX_TEXT_CHARS,
  MAX_TOOLS_PER_GRANT,
  TIMESTAMP_MAX,
  TIMESTAMP_MIN,
  TOKEN_PATTERN,
  TOOL_NAME_PATTERN,
} from './limits.js';
import { canonicalJson } from './crypto.js';

export const PROTOCOL_VERSION = 'agentport/1';

export type Hex = string;

// --- shared field schemas --------------------------------------------------

/** Ed25519/X25519 public keys: 32 bytes of canonical lowercase hex. */
const pubkey = hex(32);
/** Ed25519 signatures: 64 bytes. */
const sigHex = hex(64);
/** Opaque correlation handles (session/prompt/tool/approval ids, refs). */
const idField = pattern(ID_PATTERN, 64);
/** Human-transcribable pairing/connect codes, exactly as minted. */
const codeField = pattern(CODE_PATTERN, 9);
/** Daemon-minted resume bearer tokens. */
const tokenField = pattern(TOKEN_PATTERN, 128);
/** Unix ms inside the protocol's operating domain. */
const timestamp = int(TIMESTAMP_MIN, TIMESTAMP_MAX);
const name = str(1, MAX_NAME_CHARS);
const reason = str(0, MAX_REASON_CHARS);
const text = str(0, MAX_TEXT_CHARS);
/** Bounded arbitrary JSON: tool results may be any JSON value… */
const json = jsonValue(MAX_JSON_DEPTH, MAX_JSON_NODES, MAX_JSON_LEAF_CHARS);
/** …while schemas, arguments and context must be objects, enforced for real. */
const record = jsonRecord(MAX_JSON_DEPTH, MAX_JSON_NODES, MAX_JSON_LEAF_CHARS);
const toolName = pattern(TOOL_NAME_PATTERN, 128);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Signed statement "this user owns this agent".
 *
 * The user key is the wallet root (in a real deployment: a passkey-protected
 * key, or a NIP-46 bunker). The agent key never leaves the machine the agent
 * runs on. The relay verifies certs per connection but cannot forge them.
 */
export const AgentCert = obj({
  /** Ed25519 public key of the owning user. */
  user: pubkey,
  /** Ed25519 public key of the agent's device identity. */
  agent: pubkey,
  /** Human label shown in the agent picker, e.g. "Goga's Writing Agent". */
  name,
  /** Runtime label, e.g. "claude-code", "goose", "codex". */
  runtime: name,
  /** Where it runs, purely informational: "Personal VPS", "MacBook". */
  location: opt(name),
  /** Unix ms. */
  issuedAt: timestamp,
  /** Ed25519 signature by `user` over the canonical cert body. */
  sig: sigHex,
});
export type AgentCert = Infer<typeof AgentCert>;

/**
 * Short-lived authority from the user's wallet key to one page identity.
 *
 * The page mints `delegate` ephemerally. A relay may route a session opened
 * by that key only while this user-signed statement is live, and the daemon
 * independently verifies the same chain before accepting the session.
 */
export const SessionDelegation = obj({
  /** Ed25519 public key of the page identity allowed to open the session. */
  delegate: pubkey,
  /** Ed25519 public key of the one agent this authority may reach. */
  agent: pubkey,
  /** Browser-verified origin this authority may attach from. */
  origin: str(1, MAX_ORIGIN_CHARS),
  /**
   * SHA-256 of the canonical CapabilityGrant the user approved (`hashGrant`).
   * `session.open` must present a grant with exactly this hash: the daemon
   * enforces it authoritatively and the relay checks it structurally, so an
   * approval can never be replayed under a different toolset.
   */
  grantHash: hex(32),
  /** Unix ms. */
  expiresAt: timestamp,
  /** Signature by the target agent's owner over the canonical delegation body. */
  sig: sigHex,
});
export type SessionDelegation = Infer<typeof SessionDelegation>;

export const AgentSummary = obj({
  agent: pubkey,
  name,
  runtime: name,
  location: opt(name),
  online: bool(),
});
export type AgentSummary = Infer<typeof AgentSummary>;

// ---------------------------------------------------------------------------
// Capability grant — the piece no existing protocol has
// ---------------------------------------------------------------------------

/** A tool the *site* lends to the agent for the lifetime of the session. */
export const ToolDefinition = obj({
  /** Namespaced, e.g. "inkwell.document.replaceSelection". */
  name: toolName,
  description: str(0, MAX_DESCRIPTION_CHARS),
  /** JSON Schema for the arguments object, bounded like any embedded JSON. */
  inputSchema: record,
  /** If true the client must obtain explicit user approval per invocation. */
  requiresApproval: opt(bool()),
});
export type ToolDefinition = Infer<typeof ToolDefinition>;

/** What the site is, so the agent can reason about where it has been attached. */
export const SurfaceDescriptor = obj({
  /** Display name, e.g. "Inkwell". */
  name,
  /** Origin of the page requesting the session. Set by the client SDK. */
  origin: str(1, MAX_ORIGIN_CHARS),
  /** Optional route/resource the session is scoped to. */
  route: opt(str(0, MAX_ROUTE_CHARS)),
  /** Free-form context the site wants the agent to have at session start. */
  context: opt(record),
});
export type SurfaceDescriptor = Infer<typeof SurfaceDescriptor>;

/**
 * The structural schema alone would admit duplicate tool names — which the
 * wallet resolves last-wins and the daemon first-wins, a disagreement an
 * attacker chooses between. Refinement: names unique, alwaysAsk unique and
 * a subset of the granted tools.
 */
export const CapabilityGrant = refined(
  obj({
    tools: arr(ToolDefinition, MAX_TOOLS_PER_GRANT),
    /** Tool names that always require an approval round-trip, overriding the tool. */
    alwaysAsk: arr(toolName, MAX_TOOLS_PER_GRANT),
    /** Unix ms after which the agent must stop using this grant. */
    expiresAt: timestamp,
  }),
  (grant) => {
    const names = new Set(grant.tools.map((tool) => tool.name));
    if (names.size !== grant.tools.length) return 'duplicate';
    const ask = new Set(grant.alwaysAsk);
    if (ask.size !== grant.alwaysAsk.length) return 'duplicate';
    for (const askName of ask) if (!names.has(askName)) return 'mismatch';
    // Aggregate size, not just per-tool: 64 individually-legal definitions
    // still add up, and this grant is rendered in a consent dialog.
    if (canonicalJson(grant.tools).length > MAX_GRANT_CHARS) return 'too_long';
    return null;
  },
);
export type CapabilityGrant = Infer<typeof CapabilityGrant>;

// ---------------------------------------------------------------------------
// Relay control frames
// ---------------------------------------------------------------------------

export type Role = 'client' | 'agent';
const role = en('client', 'agent');

export const Hello = obj({
  t: lit('hello'),
  /**
   * Loosely shaped on purpose: the relay judges the version itself so an
   * incompatible peer gets a clear "unsupported version" error instead of a
   * schema rejection.
   */
  v: str(1, 32),
  role,
});
export type Hello = Infer<typeof Hello>;

export const Challenge = obj({
  t: lit('challenge'),
  /** Relay-minted, 16 random bytes. */
  nonce: hex(16),
});
export type Challenge = Infer<typeof Challenge>;

/**
 * Proof of key possession. `sig` covers `agentport-auth:<nonce>`.
 * Agents additionally present their cert (if already paired) or announce
 * themselves as unbound and follow up with `pair.begin`.
 */
export const Identify = obj({
  t: lit('identify'),
  pubkey,
  sig: sigHex,
  /** Agents only. */
  cert: opt(AgentCert),
  /** Agents only, used during first-time pairing before a cert exists. */
  announce: opt(obj({ name, runtime: name, location: opt(name) })),
});
export type Identify = Infer<typeof Identify>;

export const Ready = obj({
  t: lit('ready'),
  role,
  pubkey,
  /** Present for agents that connected with a valid cert. */
  bound: opt(bool()),
});
export type Ready = Infer<typeof Ready>;

export const ProtocolError = obj({
  t: lit('error'),
  /** Stable public code; never derived from peer input. */
  code: pattern(ERROR_CODE_PATTERN, 64),
  message: str(0, MAX_REASON_CHARS),
  /** Set when the error refers to a specific session or request. */
  ref: opt(idField),
});
export type ProtocolError = Infer<typeof ProtocolError>;

// --- pairing ---------------------------------------------------------------

/** Agent asks the relay to mint a short pairing code. */
export const PairBegin = obj({ t: lit('pair.begin') });
export type PairBegin = Infer<typeof PairBegin>;

export const PairPending = obj({
  t: lit('pair.pending'),
  code: codeField,
  expiresAt: timestamp,
});
export type PairPending = Infer<typeof PairPending>;

/** Wallet looks up a code the user typed / opened. */
export const PairClaim = obj({ t: lit('pair.claim'), code: codeField });
export type PairClaim = Infer<typeof PairClaim>;

export const PairOffer = obj({
  t: lit('pair.offer'),
  code: codeField,
  agent: obj({ pubkey, name, runtime: name, location: opt(name) }),
});
export type PairOffer = Infer<typeof PairOffer>;

/** Wallet returns a cert it signed with the user key. */
export const PairComplete = obj({
  t: lit('pair.complete'),
  code: codeField,
  cert: AgentCert,
});
export type PairComplete = Infer<typeof PairComplete>;

export const PairBound = obj({ t: lit('pair.bound'), cert: AgentCert });
export type PairBound = Infer<typeof PairBound>;

// --- drop-in connect (no wallet in the page) -------------------------------

/**
 * The WalletConnect shape.
 *
 * A site that only embeds `connect.js` has no key, no agent list, and no way
 * to consent on the user's behalf — it holds an ephemeral keypair with zero
 * authority. So it cannot *open* a session; it can only *ask* for one.
 *
 *   widget  --connect.begin-->  relay        (surface + requested grant)
 *   widget  <-connect.pending-  relay        (a short code to carry by hand)
 *   agent   --connect.claim-->  relay        (user pastes the code where their key is)
 *   agent   <-connect.offer---  relay        (here is who is asking, and for what)
 *   agent   --connect.accept->  relay        (user said yes, in their own terminal)
 *
 * The relay then synthesises the normal `session.open` toward the agent, so
 * everything downstream is the same code path as the extension flow.
 */
export const ConnectBegin = obj({
  t: lit('connect.begin'),
  surface: SurfaceDescriptor,
  grant: CapabilityGrant,
  /** Ephemeral X25519 key for sealing; carried through to the session.open. */
  epk: pubkey,
  /** Signature by the page identity over the epk and canonical request context. */
  epkSig: sigHex,
});
export type ConnectBegin = Infer<typeof ConnectBegin>;

export const ConnectPending = obj({
  t: lit('connect.pending'),
  code: codeField,
  expiresAt: timestamp,
});
export type ConnectPending = Infer<typeof ConnectPending>;

export const ConnectClaim = obj({ t: lit('connect.claim'), code: codeField });
export type ConnectClaim = Infer<typeof ConnectClaim>;

export const ConnectOffer = obj({
  t: lit('connect.offer'),
  code: codeField,
  surface: SurfaceDescriptor,
  grant: CapabilityGrant,
  /** The requesting page's authenticated identity key, stamped by the relay. */
  client: pubkey,
  /** The page's ephemeral sealing key, forwarded so consent can show fingerprint words. */
  epk: pubkey,
  epkSig: sigHex,
});
export type ConnectOffer = Infer<typeof ConnectOffer>;

export const ConnectAccept = obj({ t: lit('connect.accept'), code: codeField });
export type ConnectAccept = Infer<typeof ConnectAccept>;

export const ConnectReject = obj({
  t: lit('connect.reject'),
  code: codeField,
  reason,
});
export type ConnectReject = Infer<typeof ConnectReject>;

/** Delivered to the waiting widget when the user declines or the code dies. */
export const ConnectDenied = obj({
  t: lit('connect.denied'),
  code: codeField,
  reason,
});
export type ConnectDenied = Infer<typeof ConnectDenied>;

// --- directory / presence --------------------------------------------------

export const AgentsList = obj({ t: lit('agents.list') });
export type AgentsList = Infer<typeof AgentsList>;

export const Agents = obj({
  t: lit('agents'),
  agents: arr(AgentSummary, MAX_AGENTS_LISTED),
});
export type Agents = Infer<typeof Agents>;

export const AgentsPresence = obj({
  t: lit('agents.presence'),
  agent: pubkey,
  online: bool(),
});
export type AgentsPresence = Infer<typeof AgentsPresence>;

// ---------------------------------------------------------------------------
// Session frames (relayed)
// ---------------------------------------------------------------------------

export const SessionOpen = obj({
  t: lit('session.open'),
  s: idField,
  agent: pubkey,
  surface: SurfaceDescriptor,
  grant: CapabilityGrant,
  /** User-signed, short-lived authority for a page's ephemeral identity. */
  delegation: opt(SessionDelegation),
  /** Filled in by the relay before forwarding; ignored if sent by a client. */
  client: opt(pubkey),
  /** Client's ephemeral X25519 public key for sealing this session (ADR-003). */
  epk: pubkey,
  /** Signature by the client identity over the epk and canonical open context. */
  epkSig: sigHex,
  /**
   * Set by the relay when this session came from a drop-in widget rather than
   * a wallet. The requesting page has no key and no agent list, so approvals
   * must be answered where the user's key actually is — not in the browser.
   */
  viaConnect: opt(bool()),
});
export type SessionOpen = Infer<typeof SessionOpen>;

export const SessionOpened = obj({
  t: lit('session.opened'),
  s: idField,
  agentName: name,
  runtime: name,
  /**
   * Bearer secret stamped by the relay, letting THIS client re-attach to this
   * session after a reload. Scoped to one session, dies with it, and grants
   * nothing beyond a grant the user already approved and which still expires
   * on its own schedule.
   */
  resume: opt(tokenField),
  /** Agent's ephemeral X25519 public key; answers the client's `epk`. */
  epk: pubkey,
  /** Signature by the agent identity over both epks and canonical open context. */
  epkSig: sigHex,
  /**
   * Stamped by the relay: the agent's identity key, so a drop-in client (which
   * chose no agent and knows none) can verify `epkSig`. A paired wallet
   * already knows the key from the cert and verifies against that instead.
   */
  agent: opt(pubkey),
});
export type SessionOpened = Infer<typeof SessionOpened>;

/** Re-attach to a session whose client socket went away (a page refresh). */
export const SessionResume = obj({
  t: lit('session.resume'),
  s: idField,
  /**
   * The agent the session lives on, from the client's own resume record. The
   * relay is stateless about sessions (ADR-016): it routes this frame to that
   * agent's live socket, and the DAEMON — which minted the token — decides.
   */
  agent: pubkey,
  token: tokenField,
  /** Fresh ephemeral key — a resumed attachment never reuses the old one. */
  epk: pubkey,
  /** Signature over the epk and canonical resume request context. */
  epkSig: sigHex,
  /** Stamped by the relay before forwarding; ignored if sent by a client. */
  client: opt(pubkey),
});
export type SessionResume = Infer<typeof SessionResume>;

/**
 * Relay -> agent when the client's socket died: the session is detached, not
 * closed. The daemon holds it for its own grace period and counts (never
 * buffers) what the agent said meanwhile.
 */
export const SessionDetach = obj({ t: lit('session.detach'), s: idField });
export type SessionDetach = Infer<typeof SessionDetach>;

export const SessionResumed = obj({
  t: lit('session.resumed'),
  s: idField,
  agentName: name,
  runtime: name,
  surface: SurfaceDescriptor,
  grant: CapabilityGrant,
  /** Frames the agent sent while nobody was listening (daemon-counted). */
  missed: int(0, MAX_MISSED_COUNT),
  /** The daemon's fresh sealing key for this attachment, proof-signed. */
  epk: pubkey,
  /** Signature over both epks and canonical resume response context. */
  epkSig: sigHex,
});
export type SessionResumed = Infer<typeof SessionResumed>;

export const SessionDenied = obj({
  t: lit('session.denied'),
  s: idField,
  reason,
});
export type SessionDenied = Infer<typeof SessionDenied>;

export const SessionClose = obj({
  t: lit('session.close'),
  s: idField,
  reason: opt(reason),
});
export type SessionClose = Infer<typeof SessionClose>;

/**
 * One line of conversation, as recorded by the user's own daemon.
 *
 * Provenance rule: the transcript lives on the user's machine, next to the
 * agent that produced it. The relay never stores conversation, and the site
 * keeps nothing across a reload — on resume it asks the agent for the history
 * rather than trusting anything it cached itself.
 */
export const HistoryEntry = obj({
  role: en('user', 'agent', 'thought', 'tool', 'approval'),
  text,
  /**
   * Unix ms, from the daemon's clock — or 0 for "unknown": runtimes that
   * replay history without timestamps (ACP loadSession) cannot honestly
   * invent one, and a fabricated timestamp would be worse than none.
   */
  at: int(0, TIMESTAMP_MAX),
});
export type HistoryEntry = Infer<typeof HistoryEntry>;

/** Client asks the agent to replay the conversation it already has. */
export const HistoryRequest = obj({ t: lit('history.request'), s: idField });
export type HistoryRequest = Infer<typeof HistoryRequest>;

export const History = obj({
  t: lit('history'),
  s: idField,
  entries: arr(HistoryEntry, MAX_HISTORY_ENTRIES),
  /**
   * Set when the daemon dropped oldest entries to fit the frame bounds, so
   * the client can say "earlier conversation not shown" instead of silently
   * presenting a partial transcript as complete.
   */
  truncated: opt(bool()),
});
export type History = Infer<typeof History>;

export const Prompt = obj({
  t: lit('prompt'),
  s: idField,
  id: idField,
  text: str(1, MAX_TEXT_CHARS),
  context: opt(record),
});
export type Prompt = Infer<typeof Prompt>;

export const PromptCancel = obj({
  t: lit('prompt.cancel'),
  s: idField,
  id: idField,
});
export type PromptCancel = Infer<typeof PromptCancel>;

export const Delta = obj({
  t: lit('delta'),
  s: idField,
  promptId: idField,
  text,
});
export type Delta = Infer<typeof Delta>;

/** Agent-visible reasoning / status line, rendered differently from output. */
export const Thought = obj({
  t: lit('thought'),
  s: idField,
  promptId: idField,
  text,
});
export type Thought = Infer<typeof Thought>;

/**
 * One step of the agent's plan for this prompt.
 *
 * `status` is the whole point: a plan the user watches change is progress
 * reporting the agent already produces and we previously discarded.
 */
export const PlanStep = obj({
  text: str(1, MAX_PLAN_STEP_CHARS),
  status: en('pending', 'active', 'done'),
  /** The runtime's own ranking, when it offers one. Display only. */
  priority: opt(en('high', 'medium', 'low')),
});
export type PlanStep = Infer<typeof PlanStep>;

/**
 * The agent's current plan, as a whole.
 *
 * Snapshot semantics, not a delta: each frame REPLACES the previous plan for
 * its prompt. Plans are rewritten as the agent discovers work, and a partial
 * update whose base was dropped would render a plan that never existed.
 */
export const Plan = obj({
  t: lit('plan'),
  s: idField,
  promptId: idField,
  steps: arr(PlanStep, MAX_PLAN_STEPS),
});
export type Plan = Infer<typeof Plan>;

export const Done = obj({
  t: lit('done'),
  s: idField,
  promptId: idField,
  stopReason: en('end_turn', 'cancelled', 'error'),
  error: opt(str(0, MAX_ERROR_CHARS)),
});
export type Done = Infer<typeof Done>;

export const ToolCall = obj({
  t: lit('tool.call'),
  s: idField,
  id: idField,
  name: toolName,
  arguments: record,
});
export type ToolCall = Infer<typeof ToolCall>;

export const ToolResult = obj({
  t: lit('tool.result'),
  s: idField,
  id: idField,
  ok: bool(),
  result: opt(json),
  error: opt(str(0, MAX_ERROR_CHARS)),
});
export type ToolResult = Infer<typeof ToolResult>;

export const ApprovalRequest = obj({
  t: lit('approval.request'),
  s: idField,
  id: idField,
  /** Human-readable description of what the agent wants to do. */
  summary: str(0, MAX_DESCRIPTION_CHARS),
  /** The tool call this approval gates, when applicable. */
  call: opt(obj({ name: toolName, arguments: record })),
});
export type ApprovalRequest = Infer<typeof ApprovalRequest>;

export const ApprovalResponse = obj({
  t: lit('approval.response'),
  s: idField,
  id: idField,
  granted: bool(),
});
export type ApprovalResponse = Infer<typeof ApprovalResponse>;

/**
 * A sealed content frame (ADR-003). The relay routes it by `s` and enforces
 * participant membership, and can see nothing else — the inner frame type,
 * text, tool names and arguments are all inside the ciphertext.
 */
export const Enc = obj({
  t: lit('enc'),
  s: idField,
  /** XChaCha20 nonce, hex; its final 8 bytes are a monotonic counter. */
  n: hex(24),
  /** Ciphertext of the inner SessionFrame's JSON, incl. the Poly1305 tag. */
  c: hexRange(AEAD_TAG_BYTES, MAX_CIPHERTEXT_BYTES),
});
export type Enc = Infer<typeof Enc>;

// ---------------------------------------------------------------------------

export type ControlFrame =
  | Hello
  | Challenge
  | Identify
  | Ready
  | ProtocolError
  | PairBegin
  | PairPending
  | PairClaim
  | PairOffer
  | PairComplete
  | PairBound
  | ConnectBegin
  | ConnectPending
  | ConnectClaim
  | ConnectOffer
  | ConnectAccept
  | ConnectReject
  | ConnectDenied
  | AgentsList
  | Agents
  | AgentsPresence;

export type SessionFrame =
  | SessionOpen
  | SessionOpened
  | SessionResume
  | SessionResumed
  | SessionDetach
  | Enc
  | SessionDenied
  | HistoryRequest
  | History
  | SessionClose
  | Prompt
  | PromptCancel
  | Delta
  | Thought
  | Plan
  | Done
  | ToolCall
  | ToolResult
  | ApprovalRequest
  | ApprovalResponse;

export type Frame = ControlFrame | SessionFrame;

export type FrameType = Frame['t'];

/**
 * The complete frame registry: exact `t` → schema. decodeFrame() dispatches
 * on this; a type absent here does not exist on the wire. Typed as a total
 * record so adding a frame type without registering it is a compile error.
 */
export const FRAME_SCHEMAS: { readonly [K in FrameType]: Schema<Frame> } = {
  'hello': Hello,
  'challenge': Challenge,
  'identify': Identify,
  'ready': Ready,
  'error': ProtocolError,
  'pair.begin': PairBegin,
  'pair.pending': PairPending,
  'pair.claim': PairClaim,
  'pair.offer': PairOffer,
  'pair.complete': PairComplete,
  'pair.bound': PairBound,
  'connect.begin': ConnectBegin,
  'connect.pending': ConnectPending,
  'connect.claim': ConnectClaim,
  'connect.offer': ConnectOffer,
  'connect.accept': ConnectAccept,
  'connect.reject': ConnectReject,
  'connect.denied': ConnectDenied,
  'agents.list': AgentsList,
  'agents': Agents,
  'agents.presence': AgentsPresence,
  'session.open': SessionOpen,
  'session.opened': SessionOpened,
  'session.resume': SessionResume,
  'session.resumed': SessionResumed,
  'session.detach': SessionDetach,
  'enc': Enc,
  'session.denied': SessionDenied,
  'history.request': HistoryRequest,
  'history': History,
  'session.close': SessionClose,
  'prompt': Prompt,
  'prompt.cancel': PromptCancel,
  'delta': Delta,
  'thought': Thought,
  'plan': Plan,
  'done': Done,
  'tool.call': ToolCall,
  'tool.result': ToolResult,
  'approval.request': ApprovalRequest,
  'approval.response': ApprovalResponse,
};

/**
 * Frames the relay forwards rather than handles (the session vocabulary).
 *
 * Written as a total record over `SessionFrame['t']` for the same reason
 * FRAME_SCHEMAS is: a hand-maintained list silently drifts. Adding a session
 * frame and forgetting this set used to compile and then fail at runtime by
 * dropping the frame on the floor at the wallet's router — a missing entry is
 * now a type error instead.
 */
const SESSION_FRAME_MEMBERS = {
  'session.open': true,
  'session.opened': true,
  'session.resume': true,
  'session.resumed': true,
  'session.detach': true,
  'enc': true,
  'session.denied': true,
  'history.request': true,
  'history': true,
  'session.close': true,
  'prompt': true,
  'prompt.cancel': true,
  'delta': true,
  'thought': true,
  'plan': true,
  'done': true,
  'tool.call': true,
  'tool.result': true,
  'approval.request': true,
  'approval.response': true,
} as const satisfies Record<SessionFrame['t'], true>;

const SESSION_FRAME_TYPES = new Set<string>(Object.keys(SESSION_FRAME_MEMBERS));

export function isSessionFrame(frame: Frame): frame is SessionFrame {
  return SESSION_FRAME_TYPES.has(frame.t);
}

/**
 * Frames a client may put ON THE SOCKET inside a session: lifecycle plus
 * sealed content. Plaintext content frames are not legal on the wire at all
 * (ADR-003 sealing is mandatory; both endpoints refuse plaintext content) —
 * the relay now rejects them at origination instead of forwarding a frame
 * the far end is guaranteed to drop.
 */
/**
 * Lifecycle frames: the ones the relay must read to route, stamp, and enforce
 * its structural checks. Everything else is content and MUST be sealed.
 */
const LIFECYCLE_FRAME_MEMBERS = {
  'session.open': true,
  'session.opened': true,
  'session.resume': true,
  'session.resumed': true,
  'session.detach': true,
  'session.denied': true,
  'session.close': true,
  'enc': true,
} as const satisfies Partial<Record<SessionFrame['t'], true>>;

/** Session frames carrying conversation or tool traffic — never plaintext. */
type ContentFrameType = Exclude<SessionFrame['t'], keyof typeof LIFECYCLE_FRAME_MEMBERS>;

const CLIENT_ORIGINATED_MEMBERS = {
  'session.open': true,
  'session.resume': true,
  'session.close': true,
  'enc': true,
} as const satisfies Partial<Record<SessionFrame['t'], true>>;

/** Frames an agent may put on the socket inside a session. */
const AGENT_ORIGINATED_MEMBERS = {
  'session.opened': true,
  'session.resumed': true,
  'session.denied': true,
  'session.close': true,
  'enc': true,
} as const satisfies Partial<Record<SessionFrame['t'], true>>;

// Partial, not total: these sets are deliberately a small subset, and a frame
// missing from them is DENIED. Omission is fail-closed, so the compiler only
// needs to catch a name that is not a frame type at all.
const CLIENT_ORIGINATED = new Set<string>(Object.keys(CLIENT_ORIGINATED_MEMBERS));
const AGENT_ORIGINATED = new Set<string>(Object.keys(AGENT_ORIGINATED_MEMBERS));

export function mayOriginate(role: Role, type: string): boolean {
  return role === 'client' ? CLIENT_ORIGINATED.has(type) : AGENT_ORIGINATED.has(type);
}

/**
 * Inner frame types a CLIENT may seal toward the agent, and vice versa.
 * Because the relay cannot see inside `enc`, this per-direction rule is
 * enforced at the endpoints, in openSealed() — the single implementation
 * both the daemon and the wallet use (previously duplicated in each).
 */
const CLIENT_SEALABLE_MEMBERS = {
  'prompt': true,
  'prompt.cancel': true,
  'tool.result': true,
  'approval.response': true,
  'history.request': true,
} as const satisfies Partial<Record<ContentFrameType, true>>;

const AGENT_SEALABLE_MEMBERS = {
  'delta': true,
  'thought': true,
  'plan': true,
  'done': true,
  'tool.call': true,
  'approval.request': true,
  'history': true,
} as const satisfies Partial<Record<ContentFrameType, true>>;

/**
 * Compile-time proof that EVERY content frame is sealable in some direction.
 *
 * Unlike the originated sets, omission here is not fail-closed. Both endpoints
 * decide whether to seal by asking `SEALED_TYPES.has(frame.t)` and fall through
 * to sending the frame as-is (`daemon.ts`'s `else this.#send(frame)`), so a
 * content frame present in FRAME_SCHEMAS and the SessionFrame union but missing
 * from both sets below is sent IN THE CLEAR. The relay's mayOriginate check
 * then refuses it — but only after decoding it, and the relay is precisely the
 * party ADR-003 exists to blind. Direct mode (ADR-011) has no such check at
 * all. So the failure is silent toward the one adversary the sealing layer is
 * for, and it is one forgotten line away.
 *
 * This alias makes that omission a build error instead.
 */
type UnsealableContentFrame = Exclude<
  ContentFrameType,
  keyof typeof CLIENT_SEALABLE_MEMBERS | keyof typeof AGENT_SEALABLE_MEMBERS
>;
type AssertNever<T extends never> = T;
export type EveryContentFrameIsSealable = AssertNever<UnsealableContentFrame>;

export const CLIENT_SEALABLE = new Set<string>(Object.keys(CLIENT_SEALABLE_MEMBERS));
export const AGENT_SEALABLE = new Set<string>(Object.keys(AGENT_SEALABLE_MEMBERS));
