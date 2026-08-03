/** Collapsible, inspectable tool-call entry. */

import { component, computed, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { ToolCallEntry } from '../../lib/chat.js';
import { ChatContent } from './content.js';

const STATUS_LABEL: Record<ToolCallEntry['status'], string> = {
  pending: 'Pending',
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
};

export type ChatToolCallProps = {
  entry?: ToolCallEntry;
  /** Omit to use the failure-aware default. */
  open?: boolean;
  className?: string;
};

export const ChatToolCall = component<ChatToolCallProps>(
  'ui-chat-tool-call',
  (props, host) => {
    transparentHost(host);
    const entry = computed<ToolCallEntry>(() =>
      props.entry.value ?? { type: 'tool-call', id: '', name: 'Tool call', status: 'pending', input: '' },
    );
    const status = computed(() => entry.value.status);
    const hasOutput = computed(() => (entry.value.output?.length ?? 0) > 0);
    const hasDetail = computed(() => entry.value.input.length > 0 || hasOutput.value || entry.value.error !== undefined);
    const open = computed(() => props.open.value ?? status.value === 'error');
    const classes = computed(() =>
      cn('overflow-hidden rounded-md border bg-card', props.className.value),
    );

    return html`<details
      data-slot="chat-tool-call"
      data-status="${status}"
      class="${classes}"
      open="${open}"
    >
      <summary data-slot="chat-tool-call-summary" class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-muted/50">
        <span data-slot="chat-tool-call-glyph" aria-hidden="true">🔧</span>
        <span data-slot="chat-tool-call-name" class="min-w-0 flex-1 truncate font-medium">${computed(() => entry.value.name)}</span>
        ${computed(() =>
          status.value === 'running'
            ? html`<span data-slot="chat-tool-call-progress" class="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" aria-label="Tool call is running"></span>`
            : null,
        )}
        <span data-slot="chat-tool-call-status" class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase" role="${computed(() => (status.value === 'running' ? 'status' : undefined))}"
          >${computed(() => STATUS_LABEL[status.value])}</span
        >
      </summary>
      ${computed(() =>
        hasDetail.value
          ? html`<div data-slot="chat-tool-call-body" class="flex flex-col gap-2 border-t px-2.5 py-2">
              ${computed(() =>
                entry.value.input.length > 0
                  ? html`<section data-slot="chat-tool-call-input">
                      <div class="mb-1 text-[11px] font-medium text-muted-foreground">Input</div>
                      <pre class="max-h-48 overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs"><code>${entry.value.input}</code></pre>
                    </section>`
                  : null,
              )}
              ${computed(() =>
                hasOutput.value
                  ? html`<section data-slot="chat-tool-call-output">
                      <div class="mb-1 text-[11px] font-medium text-muted-foreground">Output</div>
                      ${ChatContent({ content: computed(() => entry.value.output ?? []) })}
                    </section>`
                  : null,
              )}
              ${computed(() =>
                entry.value.error === undefined
                  ? null
                  : html`<section data-slot="chat-tool-call-error" class="rounded border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                      <div class="mb-1 font-medium">Error</div>
                      <pre class="max-h-48 overflow-auto whitespace-pre-wrap wrap-break-word font-mono"><code>${entry.value.error}</code></pre>
                    </section>`
              )}
            </div>`
          : null,
      )}
    </details>`;
  },
  { attrs: { className: 'string' } },
);
