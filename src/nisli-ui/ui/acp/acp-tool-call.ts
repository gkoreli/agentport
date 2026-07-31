/**
 * ui/acp-tool-call.ts — ACP tool call.
 *
 * Renders one `tool_call` / `tool_call_update` entry: what the agent is doing,
 * how far along it is, and — expanded — the arguments and results. Built on
 * native `<details>`/`<summary>` so keyboard, find-in-page, and print all work
 * without a disclosure widget of our own (ADR 0019).
 *
 * Elements: ui-acp-tool-call.
 *
 * Two decisions worth keeping if you edit this file:
 *
 *  - **Collapsed by default, except when it failed.** A transcript is mostly
 *    tool calls; expanding them all buries the conversation. A failure is the
 *    one case the user always needs to read, so it opens itself.
 *  - **`kind` drives the glyph, never the tool name.** ACP added `kind` exactly
 *    so clients would stop pattern-matching on `mcp__server__do_thing`.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { component, computed, each, html } from '@nisli/core';
import { cn, cv, transparentHost } from '../../lib/utils.js';
import type { ToolCall, ToolCallStatus, ToolKind } from '../../lib/acp-protocol.js';
import { isTerminalStatus } from '../../lib/acp-protocol.js';
import { partitionToolContent } from '../../lib/acp-session.js';
import { AcpContent } from './acp-content.js';
import { AcpDiff } from './acp-diff.js';

/** Text glyphs so the component stays dependency-free; swap for your icon set. */
const KIND_GLYPH: Record<ToolKind, string> = {
  read: '📖',
  edit: '✏️',
  delete: '🗑️',
  move: '📦',
  search: '🔍',
  execute: '⚡',
  think: '💭',
  fetch: '🌐',
  switch_mode: '🔀',
  other: '🔧',
};

const STATUS_LABEL: Record<ToolCallStatus, string> = {
  pending: 'Pending',
  in_progress: 'Running',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const statusVariants = cv(
  'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase',
  {
    variants: {
      status: {
        pending: 'bg-muted text-muted-foreground',
        in_progress: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
        completed: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
        failed: 'bg-red-500/15 text-red-700 dark:text-red-300',
        cancelled: 'bg-muted text-muted-foreground line-through',
      },
    },
    defaultVariants: { status: 'pending' },
  },
);

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Circular or otherwise unserialisable raw input — show that it exists.
    return String(value);
  }
}

export type AcpToolCallProps = {
  call?: ToolCall;
  /**
   * Force the disclosure state; omit to use the failure-aware default.
   * Factory-only on purpose: a declared `'boolean'` attribute is never
   * `undefined`, which would erase the "omitted" case this default needs.
   */
  open?: boolean;
  className?: string;
};

export const AcpToolCall = component<AcpToolCallProps>(
  'ui-acp-tool-call',
  (props, host) => {
    transparentHost(host);

    const call = computed<ToolCall>(
      () => props.call.value ?? { toolCallId: '', title: 'Tool call' },
    );
    const status = computed<ToolCallStatus>(() => call.value.status ?? 'pending');
    const kind = computed<ToolKind>(() => call.value.kind ?? 'other');
    const parts = computed(() => partitionToolContent(call.value.content));
    const locations = computed(() => call.value.locations ?? []);
    const diffs = computed(() => parts.value.diffs);
    const terminals = computed(() => parts.value.terminals);

    const hasDetail = computed(
      () =>
        parts.value.blocks.length > 0 ||
        diffs.value.length > 0 ||
        terminals.value.length > 0 ||
        call.value.rawInput !== undefined ||
        call.value.rawOutput !== undefined,
    );

    const open = computed(() => props.open.value ?? status.value === 'failed');
    const classes = computed(() =>
      cn('group/acp-tool overflow-hidden rounded-md border bg-card', props.className.value),
    );

    return html`<details
      data-slot="acp-tool-call"
      data-kind="${kind}"
      data-status="${status}"
      class="${classes}"
      open="${open}"
    >
      <summary
        data-slot="acp-tool-call-summary"
        class="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-muted/50"
      >
        <span data-slot="acp-tool-call-glyph" class="shrink-0" aria-hidden="true"
          >${computed(() => KIND_GLYPH[kind.value] ?? KIND_GLYPH.other)}</span
        >
        <span data-slot="acp-tool-call-title" class="min-w-0 flex-1 truncate font-medium"
          >${computed(() => call.value.title)}</span
        >
        ${computed(() =>
          // A spinner would be noise on a settled call; only run it while running.
          isTerminalStatus(status.value)
            ? null
            : html`<span
                class="size-3 shrink-0 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground"
                aria-hidden="true"
              ></span>`,
        )}
        <span data-slot="acp-tool-call-status" class="${computed(() => statusVariants({ status: status.value }))}"
          >${computed(() => STATUS_LABEL[status.value] ?? status.value)}</span
        >
      </summary>

      ${computed(() =>
        hasDetail.value
          ? html`<div data-slot="acp-tool-call-body" class="flex flex-col gap-2 border-t px-2.5 py-2">
              ${computed(() =>
                locations.value.length > 0
                  ? html`<div data-slot="acp-tool-call-locations" class="flex flex-wrap gap-1">
                      ${each(
                        locations,
                        (location, index) => `${location.path}:${location.line ?? ''}:${index}`,
                        (location) =>
                          html`<span
                            class="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                            >${computed(
                              () =>
                                `${location.value.path}${
                                  location.value.line === undefined ? '' : `:${location.value.line}`
                                }`,
                            )}</span
                          >`,
                      )}
                    </div>`
                  : null,
              )}
              ${computed(() =>
                call.value.rawInput === undefined
                  ? null
                  : html`<div data-slot="acp-tool-call-input">
                      <div class="mb-1 text-[11px] font-medium text-muted-foreground">Arguments</div>
                      <pre
                        class="max-h-48 overflow-auto rounded border bg-muted/40 p-2 font-mono text-xs"
                      ><code>${json(call.value.rawInput)}</code></pre>
                    </div>`,
              )}
              ${each(
                diffs,
                (diff, index) => `${diff.path}:${index}`,
                (diff) =>
                  html`${computed(() =>
                    AcpDiff({
                      path: diff.value.path,
                      oldText: diff.value.oldText,
                      newText: diff.value.newText,
                    }),
                  )}`,
              )}
              ${computed(() =>
                parts.value.blocks.length > 0
                  ? AcpContent({ content: parts.value.blocks })
                  : null,
              )}
              ${each(
                terminals,
                (terminal) => terminal.terminalId,
                (terminal) =>
                  html`<div
                    data-slot="acp-tool-call-terminal"
                    class="rounded border bg-muted/40 px-2 py-1 font-mono text-xs text-muted-foreground"
                  >
                    terminal ${computed(() => terminal.value.terminalId)} — output is streamed by the
                    client that owns the terminal
                  </div>`,
              )}
            </div>`
          : null,
      )}
    </details>`;
  },
  { attrs: { className: 'string' } },
);
