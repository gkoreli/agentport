/**
 * A protocol-neutral chat transcript store.
 *
 * Adapters translate a transport's events into `ChatUpdate` before they reach
 * this file. Keeping the fold semantic means the UI can be shared by runtimes
 * with very different wire protocols.
 */

import { computed, signal, type ReadonlySignal } from '@nisli/core';

// ── Display content ─────────────────────────────────────────────────

/** Browser-safe content shapes a renderer may display without protocol types. */
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
  alt?: string;
}

export interface AudioBlock {
  type: 'audio';
  /** Base64-encoded audio bytes. */
  data: string;
  mimeType: string;
  uri?: string;
}

export interface ResourceLinkBlock {
  type: 'resource-link';
  uri: string;
  name: string;
  title?: string;
  description?: string;
}

export interface ResourceBlock {
  type: 'resource';
  uri: string;
  mimeType?: string;
  text?: string;
  /** Base64-encoded bytes when the resource has no display text. */
  data?: string;
}

export type ContentBlock = TextBlock | ImageBlock | AudioBlock | ResourceLinkBlock | ResourceBlock;

// ── Renderable entries ──────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant';
export type MessageStatus = 'streaming' | 'complete' | 'error';
export type ReasoningStatus = 'streaming' | 'complete';
export type ToolCallStatus = 'pending' | 'running' | 'complete' | 'error' | 'cancelled';

export interface MessageEntry {
  type: 'message';
  id: string;
  role: MessageRole;
  content: ContentBlock[];
  status: MessageStatus;
}

export interface ReasoningEntry {
  type: 'reasoning';
  id: string;
  content: ContentBlock[];
  status: ReasoningStatus;
}

export interface ToolCallEntry {
  type: 'tool-call';
  id: string;
  name: string;
  status: ToolCallStatus;
  /** Input chunks are appended so renderers can show a stable live request. */
  input: string;
  output?: ContentBlock[];
  error?: string;
}

export type ChatEntry = MessageEntry | ReasoningEntry | ToolCallEntry;

// ── Semantic input ──────────────────────────────────────────────────

export type ChatUpdate =
  | { type: 'run.start' }
  | { type: 'run.end' }
  | { type: 'run.error'; error: string }
  | { type: 'message.start'; id: string; role: MessageRole; content?: ContentBlock[] }
  | { type: 'message.delta'; id: string; content: ContentBlock }
  | { type: 'message.end'; id: string; status?: Exclude<MessageStatus, 'streaming'> }
  | { type: 'reasoning.start'; id: string; content?: ContentBlock[] }
  | { type: 'reasoning.delta'; id: string; content: ContentBlock }
  | { type: 'reasoning.end'; id: string }
  | { type: 'tool.start'; id: string; name: string; input?: string }
  | { type: 'tool.input'; id: string; input: string }
  | {
      type: 'tool.end';
      id: string;
      status?: Exclude<ToolCallStatus, 'pending' | 'running'>;
      output?: ContentBlock[];
      error?: string;
    };

export interface ChatState {
  entries: ChatEntry[];
  /** Whether the current run has not reached `run.end` or `run.error`. */
  running: boolean;
  /** The most recent run-level failure, cleared by `run.start` and reset. */
  error: string | null;
  /** Kept in state so generated ids remain deterministic when replaying a fold. */
  seq: number;
}

export function emptyChatState(): ChatState {
  return { entries: [], running: false, error: null, seq: 0 };
}

function appendBlock(content: readonly ContentBlock[], block: ContentBlock): ContentBlock[] {
  const previous = content[content.length - 1];
  // Coalescing text avoids a new DOM child for every streamed token while
  // retaining non-text boundaries such as images and resource links.
  if (previous?.type === 'text' && block.type === 'text') {
    return [...content.slice(0, -1), { type: 'text', text: previous.text + block.text }];
  }
  return [...content, block];
}

function appendBlocks(content: readonly ContentBlock[], blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.reduce<ContentBlock[]>((next, block) => appendBlock(next, block), [...content]);
}

function findEntry(state: ChatState, id: string, type: ChatEntry['type']): number {
  return state.entries.findIndex((entry) => entry.id === id && entry.type === type);
}

function replaceEntry(state: ChatState, index: number, entry: ChatEntry): ChatState {
  const entries = [...state.entries];
  entries[index] = entry;
  return { ...state, entries };
}

function appendEntry(state: ChatState, entry: ChatEntry): ChatState {
  return { ...state, entries: [...state.entries, entry] };
}

function settleEntries(state: ChatState, toolStatus: 'complete' | 'error'): ChatState {
  const entries = state.entries.map((entry): ChatEntry => {
    if (entry.type === 'message' && entry.status === 'streaming') return { ...entry, status: toolStatus === 'error' ? 'error' : 'complete' };
    if (entry.type === 'reasoning' && entry.status === 'streaming') return { ...entry, status: 'complete' };
    if (entry.type === 'tool-call' && (entry.status === 'pending' || entry.status === 'running')) {
      return { ...entry, status: toolStatus };
    }
    return entry;
  });
  return { ...state, entries };
}

function messageEntry(id: string, role: MessageRole, content: readonly ContentBlock[] = []): MessageEntry {
  return { type: 'message', id, role, content: [...content], status: 'streaming' };
}

function reasoningEntry(id: string, content: readonly ContentBlock[] = []): ReasoningEntry {
  return { type: 'reasoning', id, content: [...content], status: 'streaming' };
}

function toolEntry(id: string, name = id, input = ''): ToolCallEntry {
  return { type: 'tool-call', id, name, input, status: 'running' };
}

/**
 * Apply one semantic update. This is deliberately pure: a transcript can be
 * tested, replayed, or restored without a component tree or a live runtime.
 */
export function applyChatUpdate(state: ChatState, update: ChatUpdate): ChatState {
  switch (update.type) {
    case 'run.start':
      return { ...state, running: true, error: null };

    case 'run.end':
      return { ...settleEntries(state, 'complete'), running: false };

    case 'run.error':
      // A failed run must not leave a typing caret or executing tool behind.
      return { ...settleEntries(state, 'error'), running: false, error: update.error };

    case 'message.start': {
      const index = findEntry(state, update.id, 'message');
      if (index === -1) {
        return appendEntry({ ...state, running: true }, messageEntry(update.id, update.role, update.content));
      }
      const previous = state.entries[index] as MessageEntry;
      return replaceEntry(
        { ...state, running: true },
        index,
        { ...previous, role: update.role, content: appendBlocks(previous.content, update.content ?? []), status: 'streaming' },
      );
    }

    case 'message.delta': {
      const index = findEntry(state, update.id, 'message');
      if (index === -1) {
        // Some runtimes emit their first chunk before their start marker.
        return appendEntry({ ...state, running: true }, messageEntry(update.id, 'assistant', [update.content]));
      }
      const previous = state.entries[index] as MessageEntry;
      return replaceEntry(
        { ...state, running: true },
        index,
        { ...previous, content: appendBlock(previous.content, update.content), status: 'streaming' },
      );
    }

    case 'message.end': {
      const index = findEntry(state, update.id, 'message');
      if (index === -1) {
        return appendEntry(state, { ...messageEntry(update.id, 'assistant'), status: update.status ?? 'complete' });
      }
      const previous = state.entries[index] as MessageEntry;
      return replaceEntry(state, index, { ...previous, status: update.status ?? 'complete' });
    }

    case 'reasoning.start': {
      const index = findEntry(state, update.id, 'reasoning');
      if (index === -1) {
        return appendEntry({ ...state, running: true }, reasoningEntry(update.id, update.content));
      }
      const previous = state.entries[index] as ReasoningEntry;
      return replaceEntry(
        { ...state, running: true },
        index,
        { ...previous, content: appendBlocks(previous.content, update.content ?? []), status: 'streaming' },
      );
    }

    case 'reasoning.delta': {
      const index = findEntry(state, update.id, 'reasoning');
      if (index === -1) {
        return appendEntry({ ...state, running: true }, reasoningEntry(update.id, [update.content]));
      }
      const previous = state.entries[index] as ReasoningEntry;
      return replaceEntry(
        { ...state, running: true },
        index,
        { ...previous, content: appendBlock(previous.content, update.content), status: 'streaming' },
      );
    }

    case 'reasoning.end': {
      const index = findEntry(state, update.id, 'reasoning');
      if (index === -1) return appendEntry(state, { ...reasoningEntry(update.id), status: 'complete' });
      const previous = state.entries[index] as ReasoningEntry;
      return replaceEntry(state, index, { ...previous, status: 'complete' });
    }

    case 'tool.start': {
      const index = findEntry(state, update.id, 'tool-call');
      if (index === -1) return appendEntry({ ...state, running: true }, toolEntry(update.id, update.name, update.input ?? ''));
      const previous = state.entries[index] as ToolCallEntry;
      return replaceEntry(
        { ...state, running: true },
        index,
        { ...previous, name: update.name, input: previous.input + (update.input ?? ''), status: 'running' },
      );
    }

    case 'tool.input': {
      const index = findEntry(state, update.id, 'tool-call');
      if (index === -1) return appendEntry({ ...state, running: true }, toolEntry(update.id, update.id, update.input));
      const previous = state.entries[index] as ToolCallEntry;
      return replaceEntry({ ...state, running: true }, index, { ...previous, input: previous.input + update.input, status: 'running' });
    }

    case 'tool.end': {
      const index = findEntry(state, update.id, 'tool-call');
      const status = update.status ?? (update.error === undefined ? 'complete' : 'error');
      if (index === -1) {
        return appendEntry(state, { ...toolEntry(update.id), status, output: update.output, error: update.error });
      }
      const previous = state.entries[index] as ToolCallEntry;
      return replaceEntry(state, index, { ...previous, status, output: update.output, error: update.error });
    }
  }
}

// ── Reactive wrapper ────────────────────────────────────────────────

export interface ChatStore {
  entries: ReadonlySignal<ChatEntry[]>;
  running: ReadonlySignal<boolean>;
  error: ReadonlySignal<string | null>;
  apply(update: ChatUpdate): void;
  /** Add a complete local user message and return its generated stable id. */
  addUserMessage(content: string | readonly ContentBlock[]): string;
  reset(): void;
  snapshot(): ChatState;
}

export function createChatStore(initial: ChatState = emptyChatState()): ChatStore {
  const state = signal<ChatState>(initial);

  return {
    entries: computed(() => state.value.entries),
    running: computed(() => state.value.running),
    error: computed(() => state.value.error),
    apply(update) {
      state.value = applyChatUpdate(state.value, update);
    },
    addUserMessage(content) {
      const seq = state.value.seq + 1;
      const id = `user-${seq}`;
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content } satisfies TextBlock] : [...content];
      state.value = {
        ...state.value,
        seq,
        entries: [...state.value.entries, { type: 'message', id, role: 'user', content: blocks, status: 'complete' }],
      };
      return id;
    },
    reset() {
      state.value = emptyChatState();
    },
    snapshot() {
      return state.value;
    },
  };
}
