/** Stable-entry transcript dispatcher. */

import {
  component,
  computed,
  each,
  html,
  untrack,
  type ReadonlySignal,
  type TemplateResult,
} from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { ChatEntry, MessageEntry, ReasoningEntry, ToolCallEntry } from '../../lib/chat.js';
import { ChatMessage } from './message.js';
import { ChatReasoning } from './reasoning.js';
import { ChatToolCall } from './tool-call.js';
import { chatContentText } from './content.js';

type Entry<T extends ChatEntry['type']> = ReadonlySignal<Extract<ChatEntry, { type: T }>>;

/**
 * Select a renderer exactly once. A reactive discriminant would rebuild this
 * subtree on each streamed token, resetting native details and text selection.
 */
function renderEntry(entry: ReadonlySignal<ChatEntry>): TemplateResult {
  let type!: ChatEntry['type'];
  untrack(() => {
    type = entry.value.type;
  });

  switch (type) {
    case 'message':
      return html`${ChatMessage({ entry: entry as Entry<'message'> })}`;
    case 'reasoning':
      return html`${ChatReasoning({ entry: entry as Entry<'reasoning'> })}`;
    case 'tool-call':
      return html`${ChatToolCall({ entry: entry as Entry<'tool-call'> })}`;
  }
}

export type ChatTranscriptProps = {
  entries?: ChatEntry[];
  /** Shown before the first transcript entry arrives. */
  empty?: string;
  className?: string;
};

export const ChatTranscript = component<ChatTranscriptProps>(
  'ui-chat-transcript',
  (props, host) => {
    transparentHost(host);
    const entries = computed(() => props.entries.value ?? []);
    const classes = computed(() => cn('flex min-w-0 flex-col gap-3', props.className.value));
    const activity = computed(() => {
      const last = entries.value.at(-1);
      return last?.type === 'message' && last.role === 'assistant' && last.status === 'streaming'
        ? 'Assistant is responding'
        : last?.type === 'message' && last.role === 'assistant' && last.status === 'complete'
          ? `Assistant: ${chatContentText(last.content)}`
        : last?.type === 'reasoning' && last.status === 'streaming'
          ? 'Assistant is reasoning'
          : last?.type === 'tool-call' && last.status === 'running'
            ? `${last.name} is running`
            : '';
    });

    return html`<div data-slot="chat-transcript" class="${classes}" role="log" aria-live="off" aria-relevant="additions text">
      <div data-slot="chat-transcript-live" class="sr-only" aria-live="polite" aria-atomic="true">${activity}</div>
      ${computed(() =>
        entries.value.length === 0
          ? html`<div data-slot="chat-transcript-empty" class="px-3 py-8 text-center text-sm text-muted-foreground">${props.empty.value ?? 'No messages yet.'}</div>`
          : null,
      )}
      ${each(
        entries,
        // Store reducers preserve this ID across chunk updates. Never key by
        // content or index: both recreate the current streaming subtree.
        (entry) => entry.id,
        (entry) => renderEntry(entry),
      )}
    </div>`;
  },
  { attrs: { empty: 'string', className: 'string' } },
);
