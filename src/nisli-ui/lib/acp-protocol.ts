/**
 * lib/acp-protocol.ts — wire shapes for the Agent Client Protocol (ACP).
 *
 * Structural, type-only definitions of the `session/update` notification union
 * and the client-side request payloads, plus narrowing guards. Mirrors the ACP
 * schema (Apache-2.0 — https://github.com/agentclientprotocol/agent-client-protocol)
 * as of SDK 1.x.
 *
 * WHY WE RE-DECLARE INSTEAD OF IMPORTING `@agentclientprotocol/sdk`:
 * a copied registry file may only import `@nisli/core` — but the deeper reason
 * is that ACP is moving fast (0.4 → 0.22 → 1.3 in months, each a breaking
 * major). Every published ACP UI library is stranded on a dead major because
 * it type-couples to the SDK. These types describe the JSON on the wire, which
 * is versioned by `protocolVersion`, not by anyone's npm range. Narrow with
 * the guards below and unknown variants degrade instead of throwing.
 *
 * These are structural: any object from the real SDK assigns to them.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

// ── Content blocks (shared with MCP) ─────────────────────────────────

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ImageBlock {
  type: 'image';
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: string;
  uri?: string;
}

export interface AudioBlock {
  type: 'audio';
  data: string;
  mimeType: string;
}

export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface EmbeddedResourceBlock {
  type: 'resource';
  resource:
    | { uri: string; mimeType?: string; text: string }
    | { uri: string; mimeType?: string; blob: string };
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | ResourceLinkBlock
  | EmbeddedResourceBlock;

/**
 * Flatten a block's human-readable text, or `''` when it carries none.
 * Never throws on an unrecognised block — forward compatibility is the point.
 */
export function blockText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text;
    case 'resource_link':
      return block.title ?? block.name;
    case 'resource':
      return 'text' in block.resource ? block.resource.text : '';
    default:
      return '';
  }
}

/** Concatenated text of a run of blocks. Used for streaming coalescence. */
export function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks.map(blockText).join('');
}

// ── Tool calls ───────────────────────────────────────────────────────

/**
 * `cancelled` was added after `failed`; treat any unrecognised status as
 * `pending` rather than trusting this union to be closed forever.
 */
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

/**
 * What the tool does, so a client can pick an icon and an affordance without
 * pattern-matching on tool names. `other` is the documented escape hatch.
 */
export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface ToolCallLocation {
  path: string;
  line?: number;
}

/** A file edit the agent proposes or has made. */
export interface ToolCallDiff {
  type: 'diff';
  path: string;
  /** `null` when the file is being created. */
  oldText: string | null;
  newText: string;
}

/** A handle to a live terminal owned by the client. */
export interface ToolCallTerminal {
  type: 'terminal';
  terminalId: string;
}

export interface ToolCallContentBlock {
  type: 'content';
  content: ContentBlock;
}

export type ToolCallContent = ToolCallContentBlock | ToolCallDiff | ToolCallTerminal;

export interface ToolCall {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

// ── Plans ────────────────────────────────────────────────────────────

export type PlanEntryStatus = 'pending' | 'in_progress' | 'completed';
export type PlanEntryPriority = 'high' | 'medium' | 'low';

export interface PlanEntry {
  content: string;
  priority?: PlanEntryPriority;
  status?: PlanEntryStatus;
}

// ── Slash commands and modes ─────────────────────────────────────────

export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint?: string } | null;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

// ── The session/update union ─────────────────────────────────────────

export interface UserMessageChunk {
  sessionUpdate: 'user_message_chunk';
  content: ContentBlock;
}

export interface AgentMessageChunk {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
}

export interface AgentThoughtChunk {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
}

export interface ToolCallUpdateStart extends ToolCall {
  sessionUpdate: 'tool_call';
}

export interface ToolCallUpdateProgress extends Partial<ToolCall> {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
}

export interface PlanUpdate {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}

export interface AvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands: AvailableCommand[];
}

export interface CurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}

export type SessionUpdate =
  | UserMessageChunk
  | AgentMessageChunk
  | AgentThoughtChunk
  | ToolCallUpdateStart
  | ToolCallUpdateProgress
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate;

/** The notification envelope: `session/update` params. */
export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

// ── Permission requests ──────────────────────────────────────────────

/**
 * `*_always` persists the decision for the rest of the session, so a client
 * must render it distinctly from `*_once`. Presenting them identically is how
 * a user grants standing permission by accident.
 */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
}

export type RequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export function isAllowOption(option: PermissionOption): boolean {
  return option.kind === 'allow_once' || option.kind === 'allow_always';
}

export function isPersistentOption(option: PermissionOption): boolean {
  return option.kind === 'allow_always' || option.kind === 'reject_always';
}

// ── Guards ───────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * True when `value` is shaped like a session update. Deliberately shallow: it
 * checks only that the discriminant exists, so an update variant added after
 * this file was copied still passes and reaches the transcript as `unknown`
 * rather than being dropped at the door.
 */
export function isSessionUpdate(value: unknown): value is SessionUpdate {
  return isRecord(value) && typeof value['sessionUpdate'] === 'string';
}

export function isContentBlock(value: unknown): value is ContentBlock {
  return isRecord(value) && typeof value['type'] === 'string';
}

/** Message-bearing updates, which coalesce; tool/plan updates do not. */
export function isChunkUpdate(
  update: SessionUpdate,
): update is UserMessageChunk | AgentMessageChunk | AgentThoughtChunk {
  return (
    update.sessionUpdate === 'user_message_chunk' ||
    update.sessionUpdate === 'agent_message_chunk' ||
    update.sessionUpdate === 'agent_thought_chunk'
  );
}

/** A status that means the tool call will not change again. */
export function isTerminalStatus(status: ToolCallStatus | undefined): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
