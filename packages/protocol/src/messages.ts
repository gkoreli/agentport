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
 */

export const PROTOCOL_VERSION = 'agentport/1';

export type Hex = string;

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Signed statement "this user owns this agent".
 *
 * The user key is the wallet root (in a real deployment: a passkey-protected
 * key, or a NIP-46 bunker). The agent key never leaves the machine the agent
 * runs on. The relay stores certs but cannot forge them.
 */
export interface AgentCert {
  /** Ed25519 public key of the owning user. */
  user: Hex;
  /** Ed25519 public key of the agent's device identity. */
  agent: Hex;
  /** Human label shown in the agent picker, e.g. "Goga's Writing Agent". */
  name: string;
  /** Runtime label, e.g. "claude-code", "goose", "codex". */
  runtime: string;
  /** Where it runs, purely informational: "Personal VPS", "MacBook". */
  location?: string;
  /** Unix ms. */
  issuedAt: number;
  /** Ed25519 signature by `user` over the canonical cert body. */
  sig: Hex;
}

/**
 * Short-lived authority from the user's wallet key to one page identity.
 *
 * The page mints `delegate` ephemerally. A relay may route a session opened
 * by that key only while this user-signed statement is live, and the daemon
 * independently verifies the same chain before accepting the session.
 */
export interface SessionDelegation {
  /** Ed25519 public key of the page identity allowed to open the session. */
  delegate: Hex;
  /** Ed25519 public key of the one agent this authority may reach. */
  agent: Hex;
  /** Browser-verified origin this authority may attach from. */
  origin: string;
  /** Unix ms. */
  expiresAt: number;
  /** Signature by the target agent's owner over the canonical delegation body. */
  sig: Hex;
}

export interface AgentSummary {
  agent: Hex;
  name: string;
  runtime: string;
  location?: string;
  online: boolean;
}

// ---------------------------------------------------------------------------
// Capability grant — the piece no existing protocol has
// ---------------------------------------------------------------------------

/** A tool the *site* lends to the agent for the lifetime of the session. */
export interface ToolDefinition {
  /** Namespaced, e.g. "inkwell.document.replaceSelection". */
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>;
  /** If true the client must obtain explicit user approval per invocation. */
  requiresApproval?: boolean;
}

/** What the site is, so the agent can reason about where it has been attached. */
export interface SurfaceDescriptor {
  /** Display name, e.g. "Inkwell". */
  name: string;
  /** Origin of the page requesting the session. Set by the client SDK. */
  origin: string;
  /** Optional route/resource the session is scoped to. */
  route?: string;
  /** Free-form context the site wants the agent to have at session start. */
  context?: Record<string, unknown>;
}

export interface CapabilityGrant {
  tools: ToolDefinition[];
  /** Tool names that always require an approval round-trip, overriding the tool. */
  alwaysAsk: string[];
  /** Unix ms after which the agent must stop using this grant. */
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Relay control frames
// ---------------------------------------------------------------------------

export type Role = 'client' | 'agent';

export interface Hello {
  t: 'hello';
  v: string;
  role: Role;
}

export interface Challenge {
  t: 'challenge';
  nonce: string;
}

/**
 * Proof of key possession. `sig` covers `agentport-auth:<nonce>`.
 * Agents additionally present their cert (if already paired) or announce
 * themselves as unbound and follow up with `pair.begin`.
 */
export interface Identify {
  t: 'identify';
  pubkey: Hex;
  sig: Hex;
  /** Agents only. */
  cert?: AgentCert;
  /** Agents only, used during first-time pairing before a cert exists. */
  announce?: { name: string; runtime: string; location?: string };
}

export interface Ready {
  t: 'ready';
  role: Role;
  pubkey: Hex;
  /** Present for agents that connected with a valid cert. */
  bound?: boolean;
}

export interface ProtocolError {
  t: 'error';
  code: string;
  message: string;
  /** Set when the error refers to a specific session or request. */
  ref?: string;
}

// --- pairing ---------------------------------------------------------------

/** Agent asks the relay to mint a short pairing code. */
export interface PairBegin {
  t: 'pair.begin';
}

export interface PairPending {
  t: 'pair.pending';
  code: string;
  expiresAt: number;
}

/** Wallet looks up a code the user typed / opened. */
export interface PairClaim {
  t: 'pair.claim';
  code: string;
}

export interface PairOffer {
  t: 'pair.offer';
  code: string;
  agent: { pubkey: Hex; name: string; runtime: string; location?: string };
}

/** Wallet returns a cert it signed with the user key. */
export interface PairComplete {
  t: 'pair.complete';
  code: string;
  cert: AgentCert;
}

export interface PairBound {
  t: 'pair.bound';
  cert: AgentCert;
}

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
export interface ConnectBegin {
  t: 'connect.begin';
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  /** Ephemeral X25519 key for sealing; carried through to the session.open. */
  epk?: Hex;
  /** Signature by the page's (ephemeral) identity over epkProofMessage('connect', epk). */
  epkSig?: Hex;
}

export interface ConnectPending {
  t: 'connect.pending';
  code: string;
  expiresAt: number;
}

export interface ConnectClaim {
  t: 'connect.claim';
  code: string;
}

export interface ConnectOffer {
  t: 'connect.offer';
  code: string;
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  /** The requesting page's authenticated identity key, stamped by the relay. */
  client?: Hex;
  /** The page's ephemeral sealing key, forwarded so consent can show fingerprint words. */
  epk?: Hex;
  epkSig?: Hex;
}

export interface ConnectAccept {
  t: 'connect.accept';
  code: string;
}

export interface ConnectReject {
  t: 'connect.reject';
  code: string;
  reason: string;
}

/** Delivered to the waiting widget when the user declines or the code dies. */
export interface ConnectDenied {
  t: 'connect.denied';
  code: string;
  reason: string;
}

// --- directory / presence --------------------------------------------------

export interface AgentsList {
  t: 'agents.list';
}

export interface Agents {
  t: 'agents';
  agents: AgentSummary[];
}

export interface AgentsPresence {
  t: 'agents.presence';
  agent: Hex;
  online: boolean;
}

// ---------------------------------------------------------------------------
// Session frames (relayed)
// ---------------------------------------------------------------------------

export interface SessionOpen {
  t: 'session.open';
  s: string;
  agent: Hex;
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  /** User-signed, short-lived authority for a page's ephemeral identity. */
  delegation?: SessionDelegation;
  /** Filled in by the relay before forwarding; ignored if sent by a client. */
  client?: Hex;
  /** Client's ephemeral X25519 public key for sealing this session (ADR-003). */
  epk?: Hex;
  /** Signature by the client's identity key over epkProofMessage(s, epk). */
  epkSig?: Hex;
  /**
   * Set by the relay when this session came from a drop-in widget rather than
   * a wallet. The requesting page has no key and no agent list, so approvals
   * must be answered where the user's key actually is — not in the browser.
   */
  viaConnect?: boolean;
}

export interface SessionOpened {
  t: 'session.opened';
  s: string;
  agentName: string;
  runtime: string;
  /**
   * Bearer secret stamped by the relay, letting THIS client re-attach to this
   * session after a reload. Scoped to one session, dies with it, and grants
   * nothing beyond a grant the user already approved and which still expires
   * on its own schedule.
   */
  resume?: string;
  /** Agent's ephemeral X25519 public key; answers the client's `epk`. */
  epk?: Hex;
  /** Signature by the agent's device key over epkProofMessage(s, epk). */
  epkSig?: Hex;
  /**
   * Stamped by the relay: the agent's identity key, so a drop-in client (which
   * chose no agent and knows none) can verify `epkSig`. A paired wallet
   * already knows the key from the cert and verifies against that instead.
   */
  agent?: Hex;
}

/** Re-attach to a session whose client socket went away (a page refresh). */
export interface SessionResume {
  t: 'session.resume';
  s: string;
  /**
   * The agent the session lives on, from the client's own resume record. The
   * relay is stateless about sessions (ADR-016): it routes this frame to that
   * agent's live socket, and the DAEMON — which minted the token — decides.
   */
  agent: Hex;
  token: string;
  /** Fresh ephemeral key — a resumed attachment never reuses the old one. */
  epk?: Hex;
  epkSig?: Hex;
  /** Stamped by the relay before forwarding; ignored if sent by a client. */
  client?: Hex;
}

/**
 * Relay -> agent when the client's socket died: the session is detached, not
 * closed. The daemon holds it for its own grace period and counts (never
 * buffers) what the agent said meanwhile.
 */
export interface SessionDetach {
  t: 'session.detach';
  s: string;
}

export interface SessionResumed {
  t: 'session.resumed';
  s: string;
  agentName: string;
  runtime: string;
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  /** Frames the agent sent while nobody was listening (daemon-counted). */
  missed: number;
  /** The daemon's fresh sealing key for this attachment, proof-signed. */
  epk?: Hex;
  epkSig?: Hex;
}

export interface SessionDenied {
  t: 'session.denied';
  s: string;
  reason: string;
}

export interface SessionClose {
  t: 'session.close';
  s: string;
  reason?: string;
}

/**
 * One line of conversation, as recorded by the user's own daemon.
 *
 * Provenance rule: the transcript lives on the user's machine, next to the
 * agent that produced it. The relay never stores conversation, and the site
 * keeps nothing across a reload — on resume it asks the agent for the history
 * rather than trusting anything it cached itself.
 */
export interface HistoryEntry {
  role: 'user' | 'agent' | 'thought' | 'tool' | 'approval';
  text: string;
  /** Unix ms, from the daemon's clock. */
  at: number;
}

/** Client asks the agent to replay the conversation it already has. */
export interface HistoryRequest {
  t: 'history.request';
  s: string;
}

export interface History {
  t: 'history';
  s: string;
  entries: HistoryEntry[];
}

export interface Prompt {
  t: 'prompt';
  s: string;
  id: string;
  text: string;
  context?: Record<string, unknown>;
}

export interface PromptCancel {
  t: 'prompt.cancel';
  s: string;
  id: string;
}

export interface Delta {
  t: 'delta';
  s: string;
  promptId: string;
  text: string;
}

/** Agent-visible reasoning / status line, rendered differently from output. */
export interface Thought {
  t: 'thought';
  s: string;
  promptId: string;
  text: string;
}

export interface Done {
  t: 'done';
  s: string;
  promptId: string;
  stopReason: 'end_turn' | 'cancelled' | 'error';
  error?: string;
}

export interface ToolCall {
  t: 'tool.call';
  s: string;
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  t: 'tool.result';
  s: string;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface ApprovalRequest {
  t: 'approval.request';
  s: string;
  id: string;
  /** Human-readable description of what the agent wants to do. */
  summary: string;
  /** The tool call this approval gates, when applicable. */
  call?: { name: string; arguments: Record<string, unknown> };
}

/**
 * A sealed content frame (ADR-003). The relay routes it by `s` and enforces
 * participant membership, and can see nothing else — the inner frame type,
 * text, tool names and arguments are all inside the ciphertext.
 */
export interface Enc {
  t: 'enc';
  s: string;
  /** XChaCha20 nonce, hex. */
  n: Hex;
  /** Ciphertext of the inner SessionFrame's JSON. */
  c: Hex;
}

export interface ApprovalResponse {
  t: 'approval.response';
  s: string;
  id: string;
  granted: boolean;
}

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
  | Done
  | ToolCall
  | ToolResult
  | ApprovalRequest
  | ApprovalResponse;

export type Frame = ControlFrame | SessionFrame;

export type FrameType = Frame['t'];

/** Frames the relay forwards rather than handles. */
const SESSION_FRAME_TYPES = new Set<string>([
  'session.open',
  'session.opened',
  'session.resume',
  'session.resumed',
  'session.detach',
  'enc',
  'session.denied',
  'history.request',
  'history',
  'session.close',
  'prompt',
  'prompt.cancel',
  'delta',
  'thought',
  'done',
  'tool.call',
  'tool.result',
  'approval.request',
  'approval.response',
]);

export function isSessionFrame(frame: Frame): frame is SessionFrame {
  return SESSION_FRAME_TYPES.has(frame.t);
}

/** Frames a client is allowed to originate inside a session. */
const CLIENT_ORIGINATED = new Set<string>([
  'session.open',
  'session.resume',
  'session.close',
  'enc',
  'history.request',
  'prompt',
  'prompt.cancel',
  'tool.result',
  'approval.response',
]);

/** Frames an agent is allowed to originate inside a session. */
const AGENT_ORIGINATED = new Set<string>([
  'session.opened',
  'session.resumed',
  'history',
  'session.denied',
  'session.close',
  'enc',
  'delta',
  'thought',
  'done',
  'tool.call',
  'approval.request',
]);

export function mayOriginate(role: Role, type: string): boolean {
  return role === 'client' ? CLIENT_ORIGINATED.has(type) : AGENT_ORIGINATED.has(type);
}
