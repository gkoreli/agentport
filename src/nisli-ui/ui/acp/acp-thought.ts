/**
 * ui/acp-thought.ts — ACP agent reasoning.
 *
 * Renders `agent_thought_chunk` runs. Thoughts are collapsed by default and
 * visually demoted: they are the agent narrating to itself, and giving them the
 * same weight as its answer is what makes an agent transcript exhausting to
 * read. While a thought is still streaming the summary shows its live tail, so
 * the user can see progress without expanding.
 *
 * Elements: ui-acp-thought.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { component, computed, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { ContentBlock } from '../../lib/acp-protocol.js';
import { AcpContent, contentToText } from './acp-content.js';

/** Last line of in-flight reasoning, trimmed to fit a summary row. */
function tailOf(text: string, limit = 80): string {
  const line = text.trimEnd().split('\n').pop() ?? '';
  return line.length > limit ? `…${line.slice(-limit)}` : line;
}

export type AcpThoughtProps = {
  content?: ContentBlock[];
  /** True while chunks are still arriving. */
  streaming?: boolean;
  /** Force the disclosure state; factory-only (see acp-tool-call). */
  open?: boolean;
  className?: string;
};

export const AcpThought = component<AcpThoughtProps>(
  'ui-acp-thought',
  (props, host) => {
    transparentHost(host);

    const content = computed(() => props.content.value ?? []);
    const streaming = computed(() => props.streaming.value === true);
    const text = computed(() => contentToText(content.value));
    const open = computed(() => props.open.value ?? false);
    const classes = computed(() =>
      cn('rounded-md border border-dashed bg-muted/30 text-muted-foreground', props.className.value),
    );

    return html`<details
      data-slot="acp-thought"
      data-streaming="${streaming}"
      class="${classes}"
      open="${open}"
    >
      <summary
        data-slot="acp-thought-summary"
        class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-xs hover:bg-muted/50"
      >
        <span aria-hidden="true">💭</span>
        <span class="font-medium">Thinking</span>
        <span data-slot="acp-thought-tail" class="min-w-0 flex-1 truncate font-normal italic opacity-70"
          >${computed(() => (streaming.value ? tailOf(text.value) : ''))}</span
        >
        ${computed(() =>
          streaming.value
            ? html`<span
                class="size-2.5 shrink-0 animate-pulse rounded-full bg-muted-foreground/50"
                aria-hidden="true"
              ></span>`
            : null,
        )}
      </summary>
      <div data-slot="acp-thought-body" class="border-t px-2.5 py-2">
        ${computed(() => AcpContent({ content: content.value, className: 'text-xs' }))}
      </div>
    </details>`;
  },
  { attrs: { streaming: 'boolean', className: 'string' } },
);
