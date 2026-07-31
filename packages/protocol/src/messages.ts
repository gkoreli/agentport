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
  /** Filled in by the relay before forwarding; ignored if sent by a client. */
  client?: Hex;
}

export interface SessionOpened {
  t: 'session.opened';
  s: string;
  agentName: string;
  runtime: string;
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
  | AgentsList
  | Agents
  | AgentsPresence;

export type SessionFrame =
  | SessionOpen
  | SessionOpened
  | SessionDenied
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
  'session.denied',
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
  'session.close',
  'prompt',
  'prompt.cancel',
  'tool.result',
  'approval.response',
]);

/** Frames an agent is allowed to originate inside a session. */
const AGENT_ORIGINATED = new Set<string>([
  'session.opened',
  'session.denied',
  'session.close',
  'delta',
  'thought',
  'done',
  'tool.call',
  'approval.request',
]);

export function mayOriginate(role: Role, type: string): boolean {
  return role === 'client' ? CLIENT_ORIGINATED.has(type) : AGENT_ORIGINATED.has(type);
}
