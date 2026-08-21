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
  display,
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
  wireShapeOf,
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
  MAX_ANSWER_CHARS,
  MAX_ERROR_CHARS,
  MAX_FORM_FIELDS,
  MAX_FORM_LABEL_CHARS,
  MAX_FORM_OPTIONS,
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
  MAX_SESSIONS_REPORTED,
  MAX_TEXT_CHARS,
  MAX_TOOLS_PER_GRANT,
  TIMESTAMP_MAX,
  TIMESTAMP_MIN,
  TOKEN_PATTERN,
  TOOL_NAME_PATTERN,
} from './limits.js';
import { canonicalJson, toHex } from './crypto.js';
import { SESSION_DENIAL_REASONS, type SessionDenialReason } from './denials.js';
import { sha256 } from '@noble/hashes/sha256';

/**
 * A fingerprint of the entire wire: every frame type and the full NESTED
 * shape of every field, hashed.
 *
 * This exists so that forgetting to bump `PROTOCOL_VERSION` is a red build
 * rather than a thing three engineers do not notice for a day. Change any
 * frame — add a type, add a field, widen a bound, alter a signed body — and
 * this moves; `wire:check` compares it against the recorded value below and
 * fails when they disagree.
 *
 * It is deliberately NOT the version itself. The version's job is diagnosis:
 * the relay compares it at `hello` before auth, so an operator reading
 * `agentport/2 != agentport/3` in a rejection knows what happened and can
 * find a release note. Two twelve-character hashes tell them only that
 * something differs, not which side is newer — a field whose purpose is
 * diagnosis has to be diagnosable, and a hash is the least diagnosable thing
 * that could go there.
 */
export function wireFingerprint(): string {
  const types = Object.keys(FRAME_SCHEMAS).sort();
  const shapes = types.map((t) => [t, wireShapeOf(FRAME_SCHEMAS[t as FrameType])] as const);
  return toHex(sha256(new TextEncoder().encode(`agentport-wire:${canonicalJson(shapes)}`))).slice(0, 24);
}

/**
 * The fingerprint as of the current PROTOCOL_VERSION. Updated in the same
 * commit as the version, deliberately by hand — but unlike the version, a
 * stale value here CANNOT pass, because the check recomputes it.
 */
export const WIRE_FINGERPRINT = '76ebfa0c2f9f815c2095b8a5';

/**
 * The wire dialect both ends must agree on, checked at `hello` before
 * anything else happens (`relay/src/core.ts`).
 *
 * BUMP THIS WHENEVER THE WIRE OR ITS REQUIRED SECURITY SEMANTICS CHANGE — a
 * new frame type, a new field, a changed signed body, or a peer-side rule an
 * older endpoint would silently omit. Its entire job is to turn "these two
 * peers disagree" into one legible error at the handshake, instead of a
 * confusing failure after pairing and auth have already appeared to succeed.
 *
 * v2: `grantHash` and `issuedAt` on SessionDelegation (both signed, so the
 * canonical body changed too), `domain` and `callHash` on the approval pair,
 * and the `revoke`/`revoked` and `ask`/`answer` frames.
 *
 * v4: `generic_page_tool` joins the AuthorityDomain set.
 *
 * v5: every string a human reads in order to DECIDE something — tool
 * descriptions, surface names and routes, approval summaries, question
 * messages and form labels, errors and denial reasons — moved from `str` to
 * `display`, which rejects C0/DEL/C1. A tightening rather than a new field,
 * and still a wire change: a peer that used to get a session now gets
 * `bad_format`. That peer was sending terminal escape sequences into the
 * daemon owner's consent screen, so the break is the point. Content fields
 * (`text`, plan step bodies, a user's own typed answers) stay `str`.
 *
 * v6: resume is identity-bound. The frame shape is unchanged, but an older
 * daemon treats the relay-visible token as transferable endpoint authority.
 * Versioning the semantic break makes the hosted relay refuse that unsafe
 * mixed deployment instead of reporting compatibility.
 *
 * v7, one coordinated batch: `session.denied.reason` narrows from `display`
 * to the closed `SESSION_DENIAL_REASONS` vocabulary; `runtime` on
 * `session.opened`/`session.resumed` becomes optional and is omitted toward
 * every surface that is not the user's own key (the site must not learn the
 * runtime — it was the one item on the north star's "learns nothing" list
 * that shipped false); `prompt` may carry bounded image content blocks; and
 * the `grant.update`/`grant.updated` pair lets a live attachment's grant be
 * reconciled — narrowing freely, widening only under a fresh user-signed
 * delegation covering the new grant.
 *
 * This is no longer hand-maintained on its own: `WIRE_FINGERPRINT` above is
 * recomputed from the schemas on every `wire:check` run, so a wire change that
 * forgot this constant is a red build. It caught the v4 change on the first
 * run after it was written — which is the only evidence worth having that a
 * guard works.
 */
export const PROTOCOL_VERSION = 'agentport/7';

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
const name = display(1, MAX_NAME_CHARS);
const reason = display(0, MAX_REASON_CHARS);
/**
 * CONTENT, not chrome — so `str`, not `display`. Prompt text and agent output
 * are payload a surface renders as data; newlines are ordinary and a control
 * character in them cannot redraw a consent screen, because no consent screen
 * prints them. `display` is for the strings a human reads in order to decide.
 */
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
  origin: display(1, MAX_ORIGIN_CHARS),
  /**
   * SHA-256 of the canonical CapabilityGrant the user approved (`hashGrant`).
   * `session.open` must present a grant with exactly this hash: the daemon
   * enforces it authoritatively and the relay checks it structurally, so an
   * approval can never be replayed under a different toolset.
   */
  grantHash: hex(32),
  /**
   * Unix ms when the user signed this. Mandatory, and the thing revocation
   * compares against: a per-origin tombstone refuses every delegation issued
   * at or before the moment of revocation, and admits ones issued after it,
   * so approving again works without an un-revoke verb (ADR-022 R2).
   */
  issuedAt: timestamp,
  /** Unix ms. */
  expiresAt: timestamp,
  /** Signature by the target agent's owner over the canonical delegation body. */
  sig: sigHex,
});
export type SessionDelegation = Infer<typeof SessionDelegation>;

// The schema says what a delegation LOOKS like. Whether one is an authority —
// signed by this owner, naming this agent and this page key, committing to
// this grant, live on this judge's clock — is `delegation.ts#delegationAuthorizes`,
// which every judge calls instead of assembling its own conjunction.

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
  description: display(0, MAX_DESCRIPTION_CHARS),
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
  origin: display(1, MAX_ORIGIN_CHARS),
  /** Optional route/resource the session is scoped to. */
  route: opt(display(0, MAX_ROUTE_CHARS)),
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
  v: display(1, 32),
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
  message: display(0, MAX_REASON_CHARS),
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

/**
 * "This website may no longer use my agent" (ADR-022).
 *
 * Routed to the named agent, and only from a connection presenting the key
 * that agent's cert names as its owner — never from a delegated page key. A
 * page must not be able to withdraw authority: not its own (it already has
 * `session.close`) and emphatically not another origin's.
 *
 * The relay holds nothing; it forwards this and correlates the answer for the
 * lifetime of the exchange. What it learns — that this user revoked this
 * origin on this agent — it already learns from any `session.open` for the
 * same origin, whose `surface.origin` is cleartext by design (ADR-003).
 */
export const Revoke = obj({
  t: lit('revoke'),
  agent: pubkey,
  /** Every delegation this origin holds, issued before now, stops working. */
  origin: display(1, MAX_ORIGIN_CHARS),
  /**
   * Stamped by the relay from the authenticated socket; ignored if a client
   * sends it. The daemon re-checks it against its own cert, so a lying relay
   * cannot turn someone else's request into a revocation (invariant 6).
   */
  client: opt(pubkey),
});
export type Revoke = Infer<typeof Revoke>;

export const Revoked = obj({
  t: lit('revoked'),
  agent: pubkey,
  origin: display(1, MAX_ORIGIN_CHARS),
  /** Live attachments the agent ended. Feedback for the user, not authority. */
  sessions: int(0, MAX_SESSIONS_REPORTED),
});
export type Revoked = Infer<typeof Revoked>;

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
   * Bearer secret stamped by the relay, used together with THIS client's
   * stable Ed25519 proof to re-attach after a reload. Scoped to one session,
   * dies with it, and grants nothing by itself or beyond the original
   * grant/authorization boundaries.
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
  /**
   * Whether the agent may use its OWN capabilities in this attachment
   * (ADR-024 R11). False when the only surface that could answer an own-tool
   * approval is one the requesting origin draws — the daemon then refuses
   * those approvals outright rather than asking a page whether the agent may
   * use the user's own shell.
   *
   * Required, and signed into the epk proof, for two reasons. It is the value
   * the daemon ENFORCES with, not a re-derivation, so it cannot drift from
   * the policy; and a relay that could flip it would make the page tell the
   * user the opposite of what their agent is actually allowed to do.
   */
  ownTools: bool(),
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
  /** As on `session.opened`: may the agent use its own tools here (ADR-024
   *  R11). Restated on every re-attachment rather than remembered by the page,
   *  because the answer belongs to the attachment and the daemon is the only
   *  party that knows it. */
  ownTools: bool(),
});
export type SessionResumed = Infer<typeof SessionResumed>;

export const SessionDenied = obj({
  t: lit('session.denied'),
  s: idField,
  /**
   * The closed vocabulary from `denials.ts`, enforced by the SCHEMA since v7.
   * Both producers already emitted from the registry and both resume
   * consumers judged terminality from it; the deferral note that used to sit
   * here was about refusing a peer whose build knows a reason this one does
   * not — which is exactly what a lockstep version bump makes legible instead
   * of confusing, so the narrowing rode v7. A reason outside the registry is
   * now a malformed frame, not a transient retry.
   */
  reason: en(...(Object.values(SESSION_DENIAL_REASONS) as [SessionDenialReason, ...SessionDenialReason[]])),
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
  text: display(1, MAX_PLAN_STEP_CHARS),
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

/**
 * One question in an elicitation form (ADR-024).
 *
 * A closed shape rather than a JSON Schema passthrough. ACP's own form schema
 * admits five field kinds plus an open `type: string` extension point whose
 * extra keys arrive unvalidated, and an MCP server may author it freely — so
 * we translate into this and refuse what does not fit, rather than forwarding
 * something we cannot render honestly. Bounded by us, not by the asker.
 */
export const FormField = refined(
  obj({
    /** Stable key the answer is returned under. */
    key: idField,
    label: display(1, MAX_FORM_LABEL_CHARS),
    /** Absent means free text; present means choose from exactly these. */
    options: opt(arr(display(1, MAX_FORM_LABEL_CHARS), MAX_FORM_OPTIONS)),
    /** More than one option may be chosen. Only meaningful with `options`. */
    multi: opt(bool()),
  }),
  (field) => {
    if (field.options && new Set(field.options).size !== field.options.length) return 'duplicate';
    // `multi` without `options` would describe a free-text box that somehow
    // takes several answers — a shape no renderer could honour, so it is a
    // malformed question rather than a permissive one.
    if (field.multi !== undefined && field.options === undefined) return 'mismatch';
    return null;
  },
);
export type FormField = Infer<typeof FormField>;

/**
 * The agent asking its own user a question, mid-turn.
 *
 * Sealed content: the relay never sees that a question was asked, let alone
 * what it was. Only tiers whose answer surface the requesting origin cannot
 * draw, read or forge ever receive one — that is enforced upstream, by not
 * declaring the capability at all, so a refused tier's agent never asks
 * rather than asking into silence (ADR-024 R1, R2).
 */
export const Ask = obj({
  t: lit('ask'),
  s: idField,
  id: idField,
  /** What the agent needs to know, in its own words. Agent-authored. */
  message: display(1, MAX_DESCRIPTION_CHARS),
  fields: arr(FormField, MAX_FORM_FIELDS),
});
export type Ask = Infer<typeof Ask>;

/**
 * The user's answer — or their refusal to give one, which is a real outcome
 * and not an error.
 *
 * `answered` carries values; `skipped` means the user declined to answer and
 * the agent should proceed knowing that, which is what the built-in tool does
 * and what an unanswered question must decay into (ADR-024 R7/R8). There is
 * deliberately no third outcome that aborts the turn: losing the user's work
 * because they did not answer a question is a worse failure than guessing.
 */
export const Answer = refined(
  obj({
    t: lit('answer'),
    s: idField,
    id: idField,
    outcome: en('answered', 'skipped'),
    /** Present only when answered; keys are the field keys that were asked. */
    values: opt(arr(obj({ key: idField, value: str(0, MAX_ANSWER_CHARS) }), MAX_FORM_FIELDS)),
  }),
  (answer) => {
    if (answer.outcome === 'skipped' && answer.values !== undefined) return 'mismatch';
    if (answer.values && new Set(answer.values.map((v) => v.key)).size !== answer.values.length) {
      return 'duplicate';
    }
    return null;
  },
);
export type Answer = Infer<typeof Answer>;

export const Done = obj({
  t: lit('done'),
  s: idField,
  promptId: idField,
  stopReason: en('end_turn', 'cancelled', 'error'),
  error: opt(display(0, MAX_ERROR_CHARS)),
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
  error: opt(display(0, MAX_ERROR_CHARS)),
});
export type ToolResult = Infer<typeof ToolResult>;

/**
 * Which authority an approval is about (ADR-023).
 *
 * Closed, because an open string is one more thing a peer self-declares, and
 * because whoever renders this has to be able to say something true about it.
 *
 * - `site_tool` — the site declared it and lent it. Bounded by the signed
 *   grant, and the site is a party to the whole exchange.
 * - `generic_page_tool` — the EXTENSION synthesised it over a page that
 *   declared nothing. The site is not a party and has never heard of it.
 * - `runtime_own_tool` — the agent's own capability on the user's machine,
 *   bounded by nothing the site can see.
 *
 * Three different questions, and a human has to be asked them differently.
 *
 * `generic_page_tool` exists for a DISPLAY reason, not a routing one, and the
 * distinction is what keeps it small. Routing asks "does letting a page answer
 * this create escalation?", and for a generic click the answer is no — a page
 * can click its own buttons with three lines of script, so the approval never
 * protected the user from the site. Display asks what the user is being told
 * they are authorising, and calling it a tool the site lent is FALSE whether
 * or not the site could have done it itself. A true statement about capability
 * does not license a false statement about provenance.
 *
 * So this member routes exactly as `site_tool` does. That conclusion is
 * CONTINGENT, not a property of the domain: it holds because the widget tier's
 * answer surface is extension chrome. If that tier ever gains a page-answered
 * decider, the party answering would no longer hold the capability it answers
 * about, and routing would have to diverge for the same reason it did for
 * `runtime_own_tool`.
 */
export const AuthorityDomain = en('site_tool', 'generic_page_tool', 'runtime_own_tool');
export type AuthorityDomain = Infer<typeof AuthorityDomain>;

export const ApprovalRequest = obj({
  t: lit('approval.request'),
  s: idField,
  id: idField,
  /**
   * Stamped by the daemon, never by the runtime (ADR-023 R2). The runtime is
   * exactly the party that cannot be trusted to classify its own request:
   * `summary` below is already agent-chosen text, and page content steers it.
   */
  domain: AuthorityDomain,
  /**
   * Human-readable description of what the agent wants to do. Agent-authored
   * and therefore untrusted — a renderer must not present it as a verified
   * statement of what will happen.
   */
  summary: display(0, MAX_DESCRIPTION_CHARS),
  /** The tool call this approval gates, when applicable. */
  call: opt(obj({ name: toolName, arguments: record })),
  /**
   * `hashCall(call)`, present exactly when `call` is. The answering side
   * recomputes it from what it rendered and sends it back, so a decision can
   * be checked against the call it was made about (ADR-023 R6).
   */
  callHash: opt(hex(32)),
});
export type ApprovalRequest = Infer<typeof ApprovalRequest>;

export const ApprovalResponse = obj({
  t: lit('approval.response'),
  s: idField,
  id: idField,
  granted: bool(),
  /**
   * Recomputed by the responder from the call it was shown — never echoed
   * from the request, because echoing a peer's digest proves nothing. A
   * mismatch means the answer is about a different call than the question,
   * and the daemon refuses it.
   */
  callHash: opt(hex(32)),
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
  | AgentsPresence
  | Revoke
  | Revoked;

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
  | Ask
  | Answer
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
  'revoke': Revoke,
  'revoked': Revoked,
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
  'ask': Ask,
  'answer': Answer,
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
  'ask': true,
  'answer': true,
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
  'answer': true,
  'prompt': true,
  'prompt.cancel': true,
  'tool.result': true,
  'approval.response': true,
  'history.request': true,
} as const satisfies Partial<Record<ContentFrameType, true>>;

const AGENT_SEALABLE_MEMBERS = {
  'ask': true,
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
