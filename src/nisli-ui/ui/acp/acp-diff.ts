/**
 * ui/acp-diff.ts — ACP tool-call diff.
 *
 * Renders the `diff` variant of `ToolCallContent`: the file edit an agent
 * proposes or has already made. This is the highest-stakes thing an ACP client
 * draws — it is what a user reads before approving a write — so it does a real
 * line diff rather than dumping old and new side by side.
 *
 * Elements: ui-acp-diff.
 *
 * The diff is computed with a plain LCS over lines. That is O(n·m) and fine for
 * file edits an agent proposes; if you routinely diff very large files, swap
 * `diffLines` for Myers and keep the row shape.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { component, computed, each, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';

export type DiffRowKind = 'context' | 'add' | 'remove';

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** 1-based line number in the old file, or null for an addition. */
  oldLine: number | null;
  /** 1-based line number in the new file, or null for a removal. */
  newLine: number | null;
}

/**
 * Longest-common-subsequence line diff. `oldText: null` means the file is
 * being created, so every line is an addition.
 */
export function diffLines(oldText: string | null, newText: string): DiffRow[] {
  const before = oldText === null ? [] : oldText.split('\n');
  const after = newText.split('\n');

  // lcs[i][j] = length of the LCS of before[i:] and after[j:]
  const lcs: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i]![j] =
        before[i] === after[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      rows.push({ kind: 'context', text: before[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: 'remove', text: before[i]!, oldLine: i + 1, newLine: null });
      i++;
    } else {
      rows.push({ kind: 'add', text: after[j]!, oldLine: null, newLine: j + 1 });
      j++;
    }
  }
  while (i < before.length) {
    rows.push({ kind: 'remove', text: before[i]!, oldLine: i + 1, newLine: null });
    i++;
  }
  while (j < after.length) {
    rows.push({ kind: 'add', text: after[j]!, oldLine: null, newLine: j + 1 });
    j++;
  }

  return rows;
}

/**
 * Drop long runs of unchanged lines, keeping `padding` lines of context on each
 * side — the `@@` hunks of a unified diff, without the header arithmetic.
 */
export function collapseContext(rows: DiffRow[], padding = 3): (DiffRow | { kind: 'gap'; count: number })[] {
  const keep = new Array<boolean>(rows.length).fill(false);
  rows.forEach((row, index) => {
    if (row.kind === 'context') return;
    for (let k = Math.max(0, index - padding); k <= Math.min(rows.length - 1, index + padding); k++) {
      keep[k] = true;
    }
  });

  const out: (DiffRow | { kind: 'gap'; count: number })[] = [];
  let skipped = 0;
  rows.forEach((row, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        out.push({ kind: 'gap', count: skipped });
        skipped = 0;
      }
      out.push(row);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: 'gap', count: skipped });
  return out;
}

const ROW_CLASS: Record<DiffRowKind, string> = {
  context: 'text-muted-foreground',
  add: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  remove: 'bg-red-500/10 text-red-700 dark:text-red-300',
};

const ROW_MARK: Record<DiffRowKind, string> = { context: ' ', add: '+', remove: '-' };

export type AcpDiffProps = {
  path?: string;
  /** `null` (or omitted) means the file is being created. */
  oldText?: string | null;
  newText?: string;
  /** Unchanged lines of context to keep around each change. */
  context?: number;
  /** Render every line, including long unchanged runs. */
  full?: boolean;
  className?: string;
};

export const AcpDiff = component<AcpDiffProps>(
  'ui-acp-diff',
  (props, host) => {
    transparentHost(host);

    const rows = computed(() => diffLines(props.oldText.value ?? null, props.newText.value ?? ''));
    const display = computed(() =>
      props.full.value ? rows.value : collapseContext(rows.value, props.context.value ?? 3),
    );
    const added = computed(() => rows.value.filter((r) => r.kind === 'add').length);
    const removed = computed(() => rows.value.filter((r) => r.kind === 'remove').length);
    const created = computed(() => (props.oldText.value ?? null) === null);
    const classes = computed(() =>
      cn('overflow-hidden rounded-md border bg-background text-xs', props.className.value),
    );

    return html`<div data-slot="acp-diff" class="${classes}">
      <div
        data-slot="acp-diff-header"
        class="flex items-center gap-2 border-b bg-muted/40 px-2 py-1 font-mono"
      >
        <span class="min-w-0 truncate" title="${computed(() => props.path.value ?? '')}"
          >${computed(() => props.path.value ?? 'untitled')}</span
        >
        ${computed(() =>
          created.value
            ? html`<span class="rounded bg-emerald-500/15 px-1 text-emerald-700 dark:text-emerald-300">new</span>`
            : null,
        )}
        <span class="ml-auto shrink-0 tabular-nums">
          <span class="text-emerald-600 dark:text-emerald-400">+${added}</span>
          <span class="ml-1 text-red-600 dark:text-red-400">-${removed}</span>
        </span>
      </div>
      <div data-slot="acp-diff-body" class="max-h-96 overflow-auto font-mono leading-relaxed">
        ${each(
          display,
          (_row, index) => index,
          (row) =>
            html`${computed(() => {
              const value = row.value;
              if (value.kind === 'gap') {
                return html`<div
                  data-slot="acp-diff-gap"
                  class="bg-muted/30 px-2 py-0.5 text-center text-[10px] text-muted-foreground select-none"
                >
                  ⋯ ${value.count} unchanged ${value.count === 1 ? 'line' : 'lines'}
                </div>`;
              }
              return html`<div
                data-slot="acp-diff-row"
                data-kind="${value.kind}"
                class="${cn('flex gap-2 px-2', ROW_CLASS[value.kind])}"
              >
                <span class="w-8 shrink-0 text-right opacity-50 tabular-nums select-none"
                  >${value.oldLine ?? ''}</span
                >
                <span class="w-8 shrink-0 text-right opacity-50 tabular-nums select-none"
                  >${value.newLine ?? ''}</span
                >
                <span class="shrink-0 select-none">${ROW_MARK[value.kind]}</span>
                <span class="whitespace-pre wrap-break-word">${value.text}</span>
              </div>`;
            })}`,
        )}
      </div>
    </div>`;
  },
  {
    attrs: {
      path: 'string',
      newText: 'string',
      context: 'number',
      full: 'boolean',
      className: 'string',
    },
  },
);
