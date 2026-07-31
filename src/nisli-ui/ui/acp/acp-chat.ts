/**
 * ui/acp/acp-chat.ts — the ACP chat.
 *
 * The composed piece: a transcript above a prompt composer. This is what an
 * app mounts when it wants "a chat with the agent" rather than assembling
 * transcript + input itself.
 *
 * Elements: ui-acp-chat.
 *
 * The composer is a native <form> with a <textarea>: Enter submits,
 * Shift+Enter inserts a newline, and an empty or whitespace-only prompt never
 * fires.
 *
 * The input is NEVER disabled. ACP allows one active prompt turn per session
 * and defines no mid-turn prompt semantics — agents with streaming input
 * (Claude Code) treat one as steering; others error — so what to do with a
 * prompt submitted while `busy` is a per-agent choice the component must not
 * hardcode. Two delivery modes, toggleable when `steerable`:
 *
 *   - `queue` (default, works with every agent): the prompt joins a visible
 *     queue (each row removable) and is sent when the turn ends.
 *   - `steer`: `onPrompt` fires immediately, mid-turn — the app's connection
 *     decides what that means (streaming input, or cancel-and-resend).
 *
 * While busy with an `onCancel`, a Cancel button sits beside Send — ACP's
 * session/cancel is first-class.
 *
 * Submission surfaces twice, pick either: the `onPrompt` callback prop, and a
 * bubbling `ui-acp-prompt` CustomEvent whose detail is the prompt text.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { component, computed, each, effect, html, ref, signal } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { TranscriptEntry } from '../../lib/acp-session.js';
import { AcpTranscript } from './acp-transcript.js';

const BUTTON =
  'inline-flex shrink-0 items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50';

export type AcpChatProps = {
  entries?: TranscriptEntry[];
  /** Called with the prompt text; the `ui-acp-prompt` event fires too. */
  onPrompt?: (text: string) => void;
  /** True while a turn is in flight — later prompts queue until it ends. */
  busy?: boolean;
  /** When given, a Cancel button appears beside Send while busy. */
  onCancel?: () => void;
  /** Show the queue/steer toggle. Only enable for agents that can steer. */
  steerable?: boolean;
  /** Initial delivery mode for prompts submitted while busy. */
  mode?: 'queue' | 'steer';
  placeholder?: string;
  /** Shown by the transcript when there are no entries yet. */
  empty?: string;
  className?: string;
};

export const AcpChat = component<AcpChatProps>(
  'ui-acp-chat',
  (props, host) => {
    transparentHost(host);

    const draft = signal('');
    const queue = signal<string[]>([]);
    // Seeded from the prop once; the toggle owns it afterwards.
    const mode = signal<'queue' | 'steer'>(props.mode.value === 'steer' ? 'steer' : 'queue');
    const input = ref<HTMLTextAreaElement>();
    const busy = computed(() => props.busy.value === true);
    const canSend = computed(() => draft.value.trim().length > 0);
    const cancellable = computed(() => busy.value && props.onCancel.value !== undefined);
    const classes = computed(() =>
      cn('flex min-h-0 w-full flex-col gap-3', props.className.value),
    );

    function fire(text: string): void {
      props.onPrompt.value?.(text);
      host.dispatchEvent(
        new CustomEvent<string>('ui-acp-prompt', { detail: text, bubbles: true, composed: true }),
      );
    }

    function submit(): void {
      const text = draft.value.trim();
      if (text.length === 0) return;
      draft.value = '';
      if (input.current) input.current.value = '';
      if (busy.value && mode.value === 'queue') queue.value = [...queue.value, text];
      else fire(text);
    }

    // Drain one queued prompt per turn end. Deferred a microtask so the
    // parent's busy flip has fully settled before onPrompt flips it back.
    effect(() => {
      if (busy.value || queue.value.length === 0) return;
      queueMicrotask(() => {
        if (busy.value) return;
        const [next, ...rest] = queue.value;
        if (next === undefined) return;
        queue.value = rest;
        fire(next);
      });
    });

    function onKeydown(event: KeyboardEvent): void {
      // Enter sends; Shift+Enter keeps its native newline. IME composition
      // Enter (keyCode 229 / isComposing) must not send a half-typed prompt.
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      submit();
    }

    return html`<div data-slot="acp-chat" class="${classes}">
      <div data-slot="acp-chat-transcript" class="min-h-0 flex-1 overflow-y-auto">
        ${AcpTranscript({
          entries: computed(() => props.entries.value ?? []),
          empty: computed(() => props.empty.value ?? 'Ask the agent something.'),
        })}
      </div>
      ${each(
        queue,
        (text, index) => `${index}:${text}`,
        (text, index) =>
          html`<div
            data-slot="acp-chat-queued"
            class="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground"
          >
            <span class="font-medium uppercase tracking-wide text-[10px]">queued</span>
            <span class="min-w-0 flex-1 truncate">${text}</span>
            <button
              type="button"
              data-slot="acp-chat-queued-remove"
              class="rounded px-1 hover:bg-muted hover:text-foreground"
              aria-label="Remove queued prompt"
              @click=${() => {
                queue.value = queue.value.filter((_item, i) => i !== index.value);
              }}
            >
              ✕
            </button>
          </div>`,
      )}
      <form
        data-slot="acp-chat-composer"
        class="flex items-end gap-2 rounded-md border bg-background p-2 focus-within:ring-1 focus-within:ring-ring"
        @submit=${(event: Event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          data-slot="acp-chat-input"
          ref="${input}"
          class="max-h-40 min-h-9 w-full flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
          rows="1"
          placeholder="${computed(() =>
            busy.value
              ? props.placeholder.value ?? 'Message the agent… (queued until the turn ends)'
              : props.placeholder.value ?? 'Message the agent…',
          )}"
          @input=${(event: Event) => {
            draft.value = (event.target as HTMLTextAreaElement).value;
          }}
          @keydown=${onKeydown}
        ></textarea>
        ${computed(() =>
          cancellable.value
            ? html`<button
                type="button"
                data-slot="acp-chat-cancel"
                class="${cn(BUTTON, 'border bg-background hover:bg-muted')}"
                @click=${() => props.onCancel.value?.()}
              >
                Cancel
              </button>`
            : null,
        )}
        <button
          type="submit"
          data-slot="acp-chat-send"
          class="${cn(BUTTON, 'bg-primary text-primary-foreground hover:bg-primary/90')}"
          disabled="${computed(() => !canSend.value)}"
        >
          ${computed(() => (busy.value && mode.value === 'queue' ? 'Queue' : 'Send'))}
        </button>
      </form>
      ${computed(() =>
        props.steerable.value === true
          ? html`<div
              data-slot="acp-chat-mode"
              class="flex items-center gap-1.5 self-end text-[11px] text-muted-foreground"
            >
              <span>While the agent works:</span>
              <button
                type="button"
                data-slot="acp-chat-mode-toggle"
                role="switch"
                aria-checked="${computed(() => (mode.value === 'steer' ? 'true' : 'false'))}"
                class="rounded border px-1.5 py-0.5 font-medium hover:bg-muted"
                @click=${() => {
                  mode.value = mode.value === 'steer' ? 'queue' : 'steer';
                }}
              >
                ${computed(() => (mode.value === 'steer' ? 'steer it live' : 'queue prompts'))}
              </button>
            </div>`
          : null,
      )}
    </div>`;
  },
  { attrs: { busy: 'boolean', steerable: 'boolean', mode: 'string', placeholder: 'string', empty: 'string', className: 'string' } },
);
