/**
 * ui/chat/composer.ts — protocol-neutral prompt composer.
 *
 * A native form and textarea deliberately own submission. That keeps IME and
 * assistive-technology behaviour native while allowing a host to decide what
 * accepting a prompt means.
 */

import { component, computed, html, onMount, ref, signal } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import { buttonVariants } from '../button.js';

const MAX_COMPOSER_HEIGHT = 192;

export type ChatPromptHandler = (text: string) => boolean | void | Promise<boolean | void>;

export type ChatComposerProps = {
  busy?: boolean;
  onPrompt?: ChatPromptHandler;
  placeholder?: string;
  /** Accessible name for the textarea. Defaults to “Message”. */
  label?: string;
  className?: string;
};

/**
 * A textarea that sends on Enter and preserves its draft when the owning
 * application rejects a prompt. A return value of `false` means “not sent”.
 */
export const ChatComposer = component<ChatComposerProps>(
  'ui-chat-composer',
  (props, host) => {
    transparentHost(host);

    const draft = signal('');
    const submitting = signal(false);
    const input = ref<HTMLTextAreaElement>();
    const canSubmit = computed(() => draft.value.trim().length > 0 && !submitting.value);
    const classes = computed(() => cn('flex min-w-0 flex-col gap-2', props.className.value));

    function resize(): void {
      const textarea = input.current;
      if (!textarea) return;
      textarea.style.height = 'auto';
      const height = Math.min(textarea.scrollHeight, MAX_COMPOSER_HEIGHT);
      textarea.style.height = `${height}px`;
      textarea.style.overflowY = textarea.scrollHeight > MAX_COMPOSER_HEIGHT ? 'auto' : 'hidden';
    }

    function clearDraft(submitted: string): void {
      // Do not erase text typed while an async host callback was settling.
      if (draft.value !== submitted) return;
      draft.value = '';
      if (input.current) input.current.value = '';
      resize();
    }

    async function submit(): Promise<void> {
      const submitted = draft.value;
      const text = submitted.trim();
      if (text.length === 0 || submitting.value) return;

      submitting.value = true;
      try {
        const accepted = (await props.onPrompt.value?.(text)) !== false;
        if (!accepted) return;
        clearDraft(submitted);
        // Standalone composers still offer a declarative event surface. Chat
        // passes an onPrompt adapter, so composed chats emit only once at root.
        if (props.onPrompt.value === undefined) {
          host.dispatchEvent(
            new CustomEvent<string>('ui-chat-prompt', {
              detail: text,
              bubbles: true,
              composed: true,
            }),
          );
        }
      } catch (error) {
        // A rejected delivery is user-visible state: retain the draft and let
        // the application surface its own recovery UI without an unhandled
        // promise rejection.
        host.dispatchEvent(
          new CustomEvent<{ text: string; error: unknown }>('ui-chat-prompt-error', {
            detail: { text, error },
            bubbles: true,
            composed: true,
          }),
        );
      } finally {
        submitting.value = false;
      }
    }

    function onKeydown(event: KeyboardEvent): void {
      // IME confirmation often arrives as Enter. It must commit composition,
      // not submit an incomplete prompt.
      if (
        event.key !== 'Enter' ||
        event.shiftKey ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return;
      }
      event.preventDefault();
      void submit();
    }

    onMount(() => resize());

    return html`<div
      data-slot="chat-composer"
      data-state="${computed(() => (props.busy.value ? 'busy' : 'idle'))}"
      class="${classes}"
    >
      <form
        data-slot="chat-composer-form"
        class="flex items-end gap-2 rounded-md border bg-background p-2 focus-within:ring-1 focus-within:ring-ring"
        @submit=${(event: Event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <textarea
          ref="${input}"
          data-slot="chat-composer-input"
          data-state="${computed(() => (submitting.value ? 'submitting' : 'ready'))}"
          class="max-h-48 min-h-9 w-full flex-1 resize-none bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
          rows="1"
          aria-label="${computed(() => props.label.value ?? 'Message')}"
          placeholder="${computed(() => props.placeholder.value ?? 'Message…')}"
          @input=${(event: Event) => {
            draft.value = (event.target as HTMLTextAreaElement).value;
            resize();
          }}
          @keydown=${onKeydown}
        ></textarea>
        <button
          type="submit"
          data-slot="chat-composer-send"
          class="${buttonVariants({ variant: 'default', size: 'sm' })}"
          disabled="${computed(() => !canSubmit.value)}"
        >
          ${computed(() => (props.busy.value ? 'Queue' : 'Send'))}
        </button>
      </form>
    </div>`;
  },
  { attrs: { busy: 'boolean', placeholder: 'string', label: 'string', className: 'string' } },
);
