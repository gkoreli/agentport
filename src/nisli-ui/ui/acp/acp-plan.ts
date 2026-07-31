/**
 * ui/acp-plan.ts — ACP plan.
 *
 * Renders the `plan` session update: the agent's current task list. ACP resends
 * the whole plan on every change rather than patching it, so this component is
 * pure presentation over the latest array — there is no local state to drift.
 *
 * Elements: ui-acp-plan.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { component, computed, each, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { PlanEntry, PlanEntryPriority, PlanEntryStatus } from '../../lib/acp-protocol.js';

const STATUS_MARK: Record<PlanEntryStatus, string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
};

const STATUS_CLASS: Record<PlanEntryStatus, string> = {
  pending: 'text-muted-foreground',
  in_progress: 'text-blue-600 dark:text-blue-400 font-medium',
  completed: 'text-muted-foreground line-through',
};

const PRIORITY_CLASS: Record<PlanEntryPriority, string> = {
  high: 'bg-red-500/15 text-red-700 dark:text-red-300',
  medium: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  low: 'bg-muted text-muted-foreground',
};

export type AcpPlanProps = {
  entries?: PlanEntry[];
  /** Heading shown above the list; pass `''` to omit it. */
  label?: string;
  className?: string;
};

export const AcpPlan = component<AcpPlanProps>(
  'ui-acp-plan',
  (props, host) => {
    transparentHost(host);

    const entries = computed(() => props.entries.value ?? []);
    const done = computed(() => entries.value.filter((e) => e.status === 'completed').length);
    const label = computed(() => props.label.value ?? 'Plan');
    const classes = computed(() =>
      cn('rounded-md border bg-card px-2.5 py-2 text-sm', props.className.value),
    );

    return html`<div data-slot="acp-plan" class="${classes}">
      ${computed(() =>
        label.value === ''
          ? null
          : html`<div
              data-slot="acp-plan-header"
              class="mb-1.5 flex items-center gap-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase"
            >
              <span>${label}</span>
              <span class="tabular-nums">${done}/${computed(() => entries.value.length)}</span>
            </div>`,
      )}
      <ol data-slot="acp-plan-list" class="flex flex-col gap-1">
        ${each(
          entries,
          // The plan is a positional list that is replaced wholesale; index is
          // the only identity ACP gives us.
          (_entry, index) => index,
          (entry) => {
            const status = computed<PlanEntryStatus>(() => entry.value.status ?? 'pending');
            return html`<li
              data-slot="acp-plan-entry"
              data-status="${status}"
              class="flex items-start gap-2"
            >
              <span
                class="${computed(() => cn('shrink-0 select-none', STATUS_CLASS[status.value]))}"
                aria-hidden="true"
                >${computed(() => STATUS_MARK[status.value] ?? '○')}</span
              >
              <span class="${computed(() => cn('min-w-0 flex-1', STATUS_CLASS[status.value]))}"
                >${computed(() => entry.value.content)}</span
              >
              ${computed(() => {
                const priority = entry.value.priority;
                return priority === undefined
                  ? null
                  : html`<span
                      data-slot="acp-plan-priority"
                      class="${cn(
                        'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase',
                        PRIORITY_CLASS[priority],
                      )}"
                      >${priority}</span
                    >`;
              })}
            </li>`;
          },
        )}
      </ol>
    </div>`;
  },
  { attrs: { label: 'string', className: 'string' } },
);
