/** One user or assistant message entry, composed from Nisli's message primitives. */

import { component, computed, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { MessageEntry } from '../../lib/chat.js';
import { Bubble, BubbleContent } from '../bubble.js';
import { Message } from '../message.js';
import { ChatContent } from './content.js';

export type ChatMessageProps = {
  entry?: MessageEntry;
  className?: string;
};

export const ChatMessage = component<ChatMessageProps>(
  'ui-chat-message',
  (props, host) => {
    transparentHost(host);
    const entry = computed<MessageEntry>(() =>
      props.entry.value ?? { type: 'message', id: '', role: 'assistant', content: [], status: 'complete' },
    );
    const role = computed(() => entry.value.role);
    const status = computed(() => entry.value.status);
    const classes = computed(() => cn('min-w-0', props.className.value));

    return html`<article
      data-slot="chat-message"
      data-role="${role}"
      data-status="${status}"
      class="${classes}"
      aria-label="${computed(() => `${role.value === 'user' ? 'User' : 'Assistant'} message${status.value === 'error' ? ', error' : ''}`)}"
    >
      ${Message({
        align: computed(() => (role.value === 'user' ? 'end' : 'start')),
        children: Bubble({
          align: computed(() => (role.value === 'user' ? 'end' : 'start')),
          variant: computed(() => (status.value === 'error' ? 'destructive' : role.value === 'user' ? 'default' : 'ghost')),
          children: BubbleContent({
            children: html`${ChatContent({ content: computed(() => entry.value.content) })}
              ${computed(() =>
                status.value === 'streaming'
                  ? html`<span data-slot="chat-message-caret" class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-xs bg-current align-text-bottom" aria-hidden="true"></span>`
                  : null,
              )}`,
          }),
        }),
      })}
    </article>`;
  },
  { attrs: { className: 'string' } },
);
