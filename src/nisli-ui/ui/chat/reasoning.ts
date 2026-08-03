/** Collapsed, low-emphasis rendering for an agent's reasoning trace. */

import { component, computed, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { ReasoningEntry } from '../../lib/chat.js';
import { ChatContent, chatContentText } from './content.js';

function tail(text: string, limit = 96): string {
  const line = text.trimEnd().split('\n').pop() ?? '';
  return line.length > limit ? `…${line.slice(-limit)}` : line;
}

export type ChatReasoningProps = {
  entry?: ReasoningEntry;
  /** Override the default collapsed state when constructing from JavaScript. */
  open?: boolean;
  className?: string;
};

export const ChatReasoning = component<ChatReasoningProps>(
  'ui-chat-reasoning',
  (props, host) => {
    transparentHost(host);
    const entry = computed<ReasoningEntry>(() =>
      props.entry.value ?? { type: 'reasoning', id: '', content: [], status: 'complete' },
    );
    const streaming = computed(() => entry.value.status === 'streaming');
    const text = computed(() => chatContentText(entry.value.content));
    const open = computed(() => props.open.value ?? false);
    const classes = computed(() =>
      cn('rounded-md border border-dashed bg-muted/30 text-muted-foreground', props.className.value),
    );

    return html`<details
      data-slot="chat-reasoning"
      data-status="${computed(() => entry.value.status)}"
      class="${classes}"
      open="${open}"
    >
      <summary data-slot="chat-reasoning-summary" class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted/50">
        <span aria-hidden="true">💭</span>
        <span class="font-medium">${computed(() => (streaming.value ? 'Thinking' : 'Reasoning'))}</span>
        <span data-slot="chat-reasoning-preview" class="min-w-0 flex-1 truncate italic opacity-70"
          >${computed(() => (streaming.value ? tail(text.value) : ''))}</span
        >
        ${computed(() =>
          streaming.value
            ? html`<span data-slot="chat-reasoning-progress" class="size-2.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/50" aria-label="Reasoning is streaming"></span>`
            : null,
        )}
      </summary>
      <div data-slot="chat-reasoning-body" class="border-t px-2.5 py-2">
        ${ChatContent({ content: computed(() => entry.value.content), className: 'text-xs' })}
      </div>
    </details>`;
  },
  { attrs: { className: 'string' } },
);
