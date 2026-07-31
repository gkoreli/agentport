/**
 * lib/acp-transcript.ts — the ACP session reducer.
 *
 * Folds a stream of `session/update` notifications into a keyed, renderable
 * transcript held in signals. This is the piece worth owning: the components
 * are replaceable, but the fold from a chunk stream to a stable entry list is
 * where clients get it wrong.
 *
 * Three properties it guarantees, each of which is a bug in the naive version:
 *
 *  1. **Nothing is dropped.** The switch is exhaustive against `SessionUpdate`
 *     (enforced by the `never` check in the default arm), and an update whose
 *     discriminant this file has never heard of becomes an `unknown` entry
 *     rather than vanishing. A client that silently swallows unrecognised
 *     variants looks identical to one that is working.
 *  2. **Chunks coalesce, entries stay keyed.** Consecutive same-role chunks
 *     merge into one entry with a stable `id`, so keyed list rendering does
 *     not tear down and rebuild a message on every token.
 *  3. **Tool calls merge by id, and may arrive update-first.** Agents do emit
 *     `tool_call_update` for a call they never announced; that creates the
 *     entry instead of being discarded.
 *
 * Framework coupling is one import: `signal` from `@nisli/core`. The fold
 * itself is pure — `applyUpdate()` is exported separately so it can be tested,
 * replayed, or driven from a worker without a component tree.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { computed, signal, type ReadonlySignal } from '@nisli/core';
import {
  isTerminalStatus,
  type AvailableCommand,
  type ContentBlock,
  type PlanEntry,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
} from './acp-protocol.js';

// ── Entries ──────────────────────────────────────────────────────────

export interface MessageEntry {
  kind: 'message';
  id: string;
  role: 'user' | 'agent';
  content: ContentBlock[];
  /** True until the turn ends or a different entry interrupts the run. */
  streaming: boolean;
}

export interface ThoughtEntry {
  kind: 'thought';
  id: string;
  content: ContentBlock[];
  streaming: boolean;
}

export interface ToolCallEntry {
  kind: 'tool-call';
  id: string;
  call: ToolCall;
}

export interface PlanEntryGroup {
  kind: 'plan';
  id: string;
  entries: PlanEntry[];
}

/**
 * An update this build does not model. Rendered as a collapsed raw-JSON row —
 * visible, inert, and a signal that the copied file is behind the agent.
 */
export interface UnknownEntry {
  kind: 'unknown';
  id: string;
  sessionUpdate: string;
  raw: unknown;
}

export type TranscriptEntry =
  | MessageEntry
  | ThoughtEntry
  | ToolCallEntry
  | PlanEntryGroup
  | UnknownEntry;

// ── Pure state ───────────────────────────────────────────────────────

export interface TranscriptState {
  entries: TranscriptEntry[];
  /** Latest plan, which ACP replaces wholesale rather than appending to. */
  plan: PlanEntry[] | null;
  availableCommands: AvailableCommand[];
  currentModeId: string | null;
  /** Monotonic id source; kept in state so a fold is fully deterministic. */
  seq: number;
}

export function emptyTranscript(): TranscriptState {
  return { entries: [], plan: null, availableCommands: [], currentModeId: null, seq: 0 };
}

function tail(state: TranscriptState): TranscriptEntry | undefined {
  return state.entries[state.entries.length - 1];
}

/**
 * Append `block` to the trailing entry when it is a still-streaming run of the
 * same kind and role, otherwise start a new entry. Text merges into the
 * preceding text block so a message is one block, not one block per token.
 */
function appendChunk(
  state: TranscriptState,
  kind: 'message' | 'thought',
  role: 'user' | 'agent',
  block: ContentBlock,
): TranscriptState {
  const last = tail(state);
  const continues =
    last !== undefined &&
    last.kind === kind &&
    last.streaming &&
    (last.kind !== 'message' || last.role === role);

  if (continues) {
    const previous = last as MessageEntry | ThoughtEntry;
    const content = [...previous.content];
    const end = content[content.length - 1];
    if (end?.type === 'text' && block.type === 'text') {
      content[content.length - 1] = { type: 'text', text: end.text + block.text };
    } else {
      content.push(block);
    }
    const merged = { ...previous, content } as TranscriptEntry;
    return { ...state, entries: [...state.entries.slice(0, -1), merged] };
  }

  // A chunk of a different kind/role ends the previous run — settle it, or a
  // user message interrupted by a thought keeps its streaming caret forever.
  const settled = settle(state);
  const seq = settled.seq + 1;
  const entry: TranscriptEntry =
    kind === 'message'
      ? { kind: 'message', id: `m${seq}`, role, content: [block], streaming: true }
      : { kind: 'thought', id: `t${seq}`, content: [block], streaming: true };
  return { ...settled, seq, entries: [...settled.entries, entry] };
}

/** Merge a `tool_call_update` into an existing call without clobbering fields. */
function mergeCall(previous: ToolCall, patch: Partial<ToolCall>): ToolCall {
  const next: ToolCall = { ...previous };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.kind !== undefined) next.kind = patch.kind;
  if (patch.status !== undefined) next.status = patch.status;
  if (patch.rawInput !== undefined) next.rawInput = patch.rawInput;
  if (patch.rawOutput !== undefined) next.rawOutput = patch.rawOutput;
  if (patch.locations !== undefined) next.locations = patch.locations;
  // Content is a replace, not a concat: an agent that streams partial output
  // resends the full content array, and appending would duplicate it.
  if (patch.content !== undefined) next.content = patch.content;
  return next;
}

function upsertToolCall(state: TranscriptState, patch: Partial<ToolCall> & { toolCallId: string }): TranscriptState {
  const index = state.entries.findIndex(
    (entry) => entry.kind === 'tool-call' && entry.call.toolCallId === patch.toolCallId,
  );

  if (index === -1) {
    // Update-before-announce. Real agents do this; create rather than drop.
    const seq = state.seq + 1;
    const call: ToolCall = { toolCallId: patch.toolCallId, title: patch.title ?? patch.toolCallId };
    const entry: ToolCallEntry = {
      kind: 'tool-call',
      id: `c${seq}:${patch.toolCallId}`,
      call: mergeCall(call, patch),
    };
    return { ...state, seq, entries: [...state.entries, entry] };
  }

  const existing = state.entries[index] as ToolCallEntry;
  const entries = [...state.entries];
  entries[index] = { ...existing, call: mergeCall(existing.call, patch) };
  return { ...state, entries };
}

/** Close any open streaming run, so the next chunk starts a fresh entry. */
function settle(state: TranscriptState): TranscriptState {
  const last = tail(state);
  if (last === undefined || (last.kind !== 'message' && last.kind !== 'thought') || !last.streaming) {
    return state;
  }
  return {
    ...state,
    entries: [...state.entries.slice(0, -1), { ...last, streaming: false } as TranscriptEntry],
  };
}

/**
 * The fold. Pure: same state + same update always yields the same next state.
 *
 * The `default` arm's `never` assignment is load-bearing — widening
 * `SessionUpdate` without handling the new variant here is a type error at
 * build time instead of a blank row at runtime.
 */
export function applyUpdate(state: TranscriptState, update: SessionUpdate): TranscriptState {
  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return appendChunk(state, 'message', 'user', update.content);

    case 'agent_message_chunk':
      return appendChunk(state, 'message', 'agent', update.content);

    case 'agent_thought_chunk':
      return appendChunk(state, 'thought', 'agent', update.content);

    case 'tool_call': {
      const { sessionUpdate: _ignored, ...call } = update;
      return upsertToolCall(settle(state), call);
    }

    case 'tool_call_update': {
      const { sessionUpdate: _ignored, ...patch } = update;
      return upsertToolCall(state, patch);
    }

    case 'plan': {
      // ACP sends the whole plan each time; the newest one replaces the entry
      // in place so the transcript does not accumulate stale copies.
      const settled = settle(state);
      const index = settled.entries.findIndex((entry) => entry.kind === 'plan');
      if (index === -1) {
        const seq = settled.seq + 1;
        const entry: PlanEntryGroup = { kind: 'plan', id: `p${seq}`, entries: update.entries };
        return { ...settled, seq, plan: update.entries, entries: [...settled.entries, entry] };
      }
      const entries = [...settled.entries];
      entries[index] = { ...(entries[index] as PlanEntryGroup), entries: update.entries };
      return { ...settled, plan: update.entries, entries };
    }

    case 'available_commands_update':
      return { ...state, availableCommands: update.availableCommands };

    case 'current_mode_update':
      return { ...state, currentModeId: update.currentModeId };

    default: {
      // Exhaustiveness guard — see the doc comment above.
      const unreachable: never = update;
      const raw = unreachable as { sessionUpdate?: unknown };
      const settled = settle(state);
      const seq = settled.seq + 1;
      const entry: UnknownEntry = {
        kind: 'unknown',
        id: `u${seq}`,
        sessionUpdate: String(raw?.sessionUpdate ?? 'unknown'),
        raw: unreachable,
      };
      return { ...settled, seq, entries: [...settled.entries, entry] };
    }
  }
}

/** Mark every streaming entry settled. Call when `session/prompt` resolves. */
export function endTurn(state: TranscriptState): TranscriptState {
  return settle(state);
}

// ── Reactive store ───────────────────────────────────────────────────

export interface Transcript {
  entries: ReadonlySignal<TranscriptEntry[]>;
  plan: ReadonlySignal<PlanEntry[] | null>;
  availableCommands: ReadonlySignal<AvailableCommand[]>;
  currentModeId: ReadonlySignal<string | null>;
  /** True while any entry is still streaming. */
  streaming: ReadonlySignal<boolean>;
  /** Tool calls that have not reached a terminal status. */
  pendingToolCalls: ReadonlySignal<ToolCallEntry[]>;
  /** Accepts a bare update or a full `session/update` notification. */
  apply(update: SessionUpdate | SessionNotification): void;
  /** Settle streaming entries; call when the prompt turn resolves. */
  endTurn(): void;
  reset(): void;
  /** Current pure state, for persistence or debugging. */
  snapshot(): TranscriptState;
}

function isNotification(value: SessionUpdate | SessionNotification): value is SessionNotification {
  return 'update' in value;
}

export function createTranscript(initial: TranscriptState = emptyTranscript()): Transcript {
  const state = signal<TranscriptState>(initial);

  return {
    entries: computed(() => state.value.entries),
    plan: computed(() => state.value.plan),
    availableCommands: computed(() => state.value.availableCommands),
    currentModeId: computed(() => state.value.currentModeId),
    streaming: computed(() =>
      state.value.entries.some(
        (entry) => (entry.kind === 'message' || entry.kind === 'thought') && entry.streaming,
      ),
    ),
    pendingToolCalls: computed(() =>
      state.value.entries.filter(
        (entry): entry is ToolCallEntry =>
          entry.kind === 'tool-call' && !isTerminalStatus(entry.call.status),
      ),
    ),
    apply(update) {
      state.value = applyUpdate(state.value, isNotification(update) ? update.update : update);
    },
    endTurn() {
      state.value = endTurn(state.value);
    },
    reset() {
      state.value = emptyTranscript();
    },
    snapshot() {
      return state.value;
    },
  };
}

// ── Presentation helpers ─────────────────────────────────────────────

/** Split a tool call's content into the three shapes a client renders. */
export function partitionToolContent(content: readonly ToolCallContent[] | undefined): {
  blocks: ContentBlock[];
  diffs: Extract<ToolCallContent, { type: 'diff' }>[];
  terminals: Extract<ToolCallContent, { type: 'terminal' }>[];
} {
  const blocks: ContentBlock[] = [];
  const diffs: Extract<ToolCallContent, { type: 'diff' }>[] = [];
  const terminals: Extract<ToolCallContent, { type: 'terminal' }>[] = [];

  for (const item of content ?? []) {
    if (item.type === 'content') blocks.push(item.content);
    else if (item.type === 'diff') diffs.push(item);
    else if (item.type === 'terminal') terminals.push(item);
  }

  return { blocks, diffs, terminals };
}
