/**
 * The composed chat shell. Entry rendering belongs to ChatTranscript; this
 * component owns the interaction boundary around it: queue, cancellation,
 * suggestions, composer, and the shared message-scroller layout.
 */

import { component, computed, effect, each, html, signal } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { ChatEntry } from '../../lib/chat.js';
import { buttonVariants } from '../button.js';
import { MessageScroller, MessageScrollerButton, MessageScrollerContent, MessageScrollerViewport } from '../message-scroller.js';
import { ChatComposer, type ChatPromptHandler } from './composer.js';
import { ChatGenerationControls } from './generation-controls.js';
import { ChatSuggestions, type ChatSuggestion } from './suggestions.js';
import { ChatTranscript } from './transcript.js';

type QueuedPrompt = { id: number; text: string };

export interface ChatController {
  /** Submit through the same busy-aware queue used by the composer. */
  send(text: string): boolean;
}

export type ChatProps = {
  entries?: ChatEntry[];
  busy?: boolean;
  onPrompt?: ChatPromptHandler;
  onCancel?: () => void;
  placeholder?: string;
  empty?: string;
  suggestions?: ChatSuggestion[];
  bind?: (controller: ChatController) => void;
  className?: string;
};

export const Chat = component<ChatProps>(
  'ui-chat',
  (props, host) => {
    transparentHost(host);

    const busy = computed(() => props.busy.value === true);
    const entries = computed(() => props.entries.value ?? []);
    const queue = signal<QueuedPrompt[]>([]);
    const failedId = signal<number | undefined>(undefined);
    const draining = signal(false);
    const waitingForRun = signal(false);
    const sawBusy = signal(false);
    let nextQueueId = 0;
    let drainScheduled = false;

    const classes = computed(() => cn('flex min-h-0 w-full flex-col gap-3', props.className.value));

    async function deliver(text: string): Promise<boolean> {
      const accepted = (await props.onPrompt.value?.(text)) !== false;
      if (accepted) {
        host.dispatchEvent(
          new CustomEvent<string>('ui-chat-prompt', { detail: text, bubbles: true, composed: true }),
        );
      }
      return accepted;
    }

    const promptOrQueue: ChatPromptHandler = async (text) => {
      if (busy.value) {
        queue.value = [...queue.value, { id: nextQueueId++, text }];
        return true;
      }
      return deliver(text);
    };

    props.bind.value?.({
      send(value) {
        const text = value.trim();
        if (text.length === 0) return false;
        if (busy.value) {
          queue.value = [...queue.value, { id: nextQueueId++, text }];
          return true;
        }
        void deliver(text).catch((error: unknown) => {
          host.dispatchEvent(
            new CustomEvent<{ text: string; error: unknown }>('ui-chat-prompt-error', {
              detail: { text, error },
              bubbles: true,
              composed: true,
            }),
          );
        });
        return true;
      },
    });

    function scheduleDrain(): void {
      if (drainScheduled) return;
      drainScheduled = true;
      queueMicrotask(() => {
        drainScheduled = false;
        void drainOne();
      });
    }

    async function drainOne(): Promise<void> {
      const current = queue.value[0];
      if (
        current === undefined ||
        busy.value ||
        draining.value ||
        waitingForRun.value ||
        failedId.value === current.id
      ) {
        return;
      }

      draining.value = true;
      sawBusy.value = false;
      try {
        const accepted = await deliver(current.text);
        if (!accepted) {
          failedId.value = current.id;
          return;
        }
        queue.value = queue.value.filter((item) => item.id !== current.id);

        // `busy` is the source of truth for a completed run. If it has already
        // transitioned back to false while an async handler settled, one run
        // has completed and the effect may release the next queued prompt.
        if (sawBusy.value && !busy.value) sawBusy.value = false;
        else waitingForRun.value = true;
      } catch (error) {
        failedId.value = current.id;
        host.dispatchEvent(
          new CustomEvent<{ text: string; error: unknown }>('ui-chat-queue-error', {
            detail: { text: current.text, error },
            bubbles: true,
            composed: true,
          }),
        );
      } finally {
        draining.value = false;
      }
    }

    effect(() => {
      if ((draining.value || waitingForRun.value) && busy.value) sawBusy.value = true;
      if (waitingForRun.value && sawBusy.value && !busy.value) {
        waitingForRun.value = false;
        sawBusy.value = false;
      }

      const first = queue.value[0];
      if (
        !busy.value &&
        !draining.value &&
        !waitingForRun.value &&
        first !== undefined &&
        failedId.value !== first.id
      ) {
        scheduleDrain();
      }
    });

    function removeQueued(id: number): void {
      queue.value = queue.value.filter((item) => item.id !== id);
      if (failedId.value === id) failedId.value = undefined;
    }

    return html`<div data-slot="chat" data-state="${computed(() => (busy.value ? 'busy' : 'idle'))}" class="${classes}">
      ${MessageScroller({
        className: 'flex-1',
        children: html`${MessageScrollerViewport({
          className: 'relative',
          children: html`${MessageScrollerContent({
            className: 'gap-3 px-1',
            children: ChatTranscript({
              entries,
              empty: computed(() => props.empty.value ?? 'Ask the agent something.'),
            }),
          })}`,
        })}${html`<div data-slot="chat-jump-to-latest">${MessageScrollerButton({
          direction: 'end',
          className: 'bottom-3',
          children: html`<span data-slot="chat-jump-to-latest-label">Jump to latest</span>`,
        })}</div>`}`,
      })}
      ${each(
        queue,
        (item) => item.id,
        (item) => html`<div data-slot="chat-queued" data-state="${computed(() =>
          failedId.value === item.value.id ? 'failed' : 'queued',
        )}" class="flex items-center gap-2 rounded-md border border-dashed px-2.5 py-1.5 text-sm">
          <span data-slot="chat-queued-status" class="text-xs text-muted-foreground">${computed(() =>
            failedId.value === item.value.id ? 'Not sent' : 'Queued',
          )}</span>
          <span data-slot="chat-queued-text" class="min-w-0 flex-1 truncate">${computed(() => item.value.text)}</span>
          <button type="button" data-slot="chat-queued-remove" class="${buttonVariants({ variant: 'ghost', size: 'icon-xs' })}" aria-label="Remove queued prompt" @click=${() => removeQueued(item.value.id)}>×</button>
        </div>`,
      )}
      ${ChatSuggestions({ suggestions: props.suggestions, onPrompt: promptOrQueue })}
      <div data-slot="chat-composer-row" class="flex items-end gap-2">
        ${ChatComposer({ busy, onPrompt: promptOrQueue, placeholder: props.placeholder })}
        ${ChatGenerationControls({ busy, onCancel: props.onCancel })}
      </div>
    </div>`;
  },
  { attrs: { busy: 'boolean', placeholder: 'string', empty: 'string', className: 'string' } },
);
