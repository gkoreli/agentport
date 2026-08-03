/** Clickable prompt suggestions — a small, protocol-neutral chip strip. */

import { component, computed, each, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import { buttonVariants } from '../button.js';
import type { ChatPromptHandler } from './composer.js';

export type ChatSuggestion =
  | string
  | {
      /** Stable identity for keyed rendering; defaults to the prompt. */
      id?: string;
      /** Visible button text. */
      label: string;
      /** Text delivered to the agent; defaults to `label`. */
      prompt?: string;
      description?: string;
    };

export type ChatSuggestionsProps = {
  suggestions?: ChatSuggestion[];
  onPrompt?: ChatPromptHandler;
  className?: string;
};

function promptOf(suggestion: ChatSuggestion): string {
  return typeof suggestion === 'string' ? suggestion : suggestion.prompt ?? suggestion.label;
}

function labelOf(suggestion: ChatSuggestion): string {
  return typeof suggestion === 'string' ? suggestion : suggestion.label;
}

function keyOf(suggestion: ChatSuggestion, index: number): string {
  return typeof suggestion === 'string' ? `${index}:${suggestion}` : suggestion.id ?? `${index}:${promptOf(suggestion)}`;
}

export const ChatSuggestions = component<ChatSuggestionsProps>(
  'ui-chat-suggestions',
  (props, host) => {
    transparentHost(host);
    const suggestions = computed(() => props.suggestions.value ?? []);
    const classes = computed(() => cn('flex flex-wrap gap-2', props.className.value));

    async function choose(suggestion: ChatSuggestion): Promise<void> {
      const text = promptOf(suggestion).trim();
      if (text.length === 0) return;
      try {
        const accepted = (await props.onPrompt.value?.(text)) !== false;
        if (accepted && props.onPrompt.value === undefined) {
          host.dispatchEvent(
            new CustomEvent<string>('ui-chat-prompt', {
              detail: text,
              bubbles: true,
              composed: true,
            }),
          );
        }
      } catch (error) {
        host.dispatchEvent(
          new CustomEvent<{ text: string; error: unknown }>('ui-chat-prompt-error', {
            detail: { text, error },
            bubbles: true,
            composed: true,
          }),
        );
      }
    }

    return html`${computed(() =>
      suggestions.value.length === 0
        ? null
        : html`<div data-slot="chat-suggestions" class="${classes}" role="group" aria-label="Suggestions">
            ${each(
              suggestions,
              (suggestion, index) => keyOf(suggestion, index),
              (suggestion) =>
                html`<button
                  type="button"
                  data-slot="chat-suggestion"
                  class="${buttonVariants({ variant: 'outline', size: 'sm' })} rounded-full text-left"
                  title="${computed(() => labelOf(suggestion.value))}"
                  @click=${() => void choose(suggestion.value)}
                >
                  <span data-slot="chat-suggestion-label">${computed(() => labelOf(suggestion.value))}</span>
                  ${computed(() => {
                    const value = suggestion.value;
                    return typeof value === 'string' || value.description === undefined
                      ? null
                      : html`<span data-slot="chat-suggestion-description" class="block text-xs text-muted-foreground">${value.description}</span>`;
                  })}
                </button>`,
            )}
          </div>`,
    )}`;
  },
  { attrs: { className: 'string' } },
);
