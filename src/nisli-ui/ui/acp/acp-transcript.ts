/**
 * ui/acp-transcript.ts — the ACP transcript.
 *
 * The one component most apps mount: give it the `entries` signal from
 * `createTranscript()` and it dispatches each entry to the right renderer.
 * Adding a component to the set means adding an arm here — the dispatch is a
 * `switch` over `TranscriptEntry['kind']` with a `never` guard, so a new entry
 * kind cannot be forgotten silently.
 *
 * Elements: ui-acp-transcript.
 *
 * The list is keyed on `entry.id`, which the reducer keeps stable across
 * streaming chunks. Keying on content or index instead is what causes the
 * classic bug where a streaming message loses focus, selection, or scroll
 * position on every token.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import {
  component,
  computed,
  each,
  html,
  untrack,
  type ReadonlySignal,
  type TemplateResult,
} from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { TranscriptEntry } from '../../lib/acp-session.js';
import { AcpContent } from './acp-content.js';
import { AcpPlan } from './acp-plan.js';
import { AcpThought } from './acp-thought.js';
import { AcpToolCall } from './acp-tool-call.js';

type Entry<K extends TranscriptEntry['kind']> = ReadonlySignal<Extract<TranscriptEntry, { kind: K }>>;

/**
 * Every read of `entry` here happens INSIDE a computed, never in the enclosing
 * scope. That is not style: `renderEntry` builds this template from within a
 * computed, so a bare `entry.value` read would make that computed depend on the
 * whole entry object and rebuild this subtree on every streamed token.
 */
function renderMessage(entry: Entry<'message'>) {
  const user = computed(() => entry.value.role === 'user');
  return html`<div
    data-slot="acp-message"
    data-role="${computed(() => entry.value.role)}"
    class="${computed(() =>
      cn('flex w-full min-w-0', user.value ? 'justify-end' : 'justify-start'),
    )}"
  >
    <div
      class="${computed(() =>
        cn(
          'min-w-0 rounded-lg px-3 py-2',
          user.value ? 'max-w-[85%] bg-primary text-primary-foreground' : 'w-full bg-transparent',
        ),
      )}"
    >
      ${AcpContent({ content: computed(() => entry.value.content) })}
      ${computed(() =>
        entry.value.streaming
          ? html`<span
              data-slot="acp-message-caret"
              class="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-xs bg-current align-text-bottom"
              aria-hidden="true"
            ></span>`
          : null,
      )}
    </div>
  </div>`;
}

/**
 * The `unknown` renderer. It exists so that an agent speaking a newer ACP than
 * this copy produces a visible, inspectable row instead of a gap in the
 * conversation — the difference between "my client is out of date" and "the
 * agent said nothing".
 */
function renderUnknown(entry: Entry<'unknown'>) {
  return html`<details
    data-slot="acp-unknown"
    class="rounded-md border border-dashed bg-muted/20 text-muted-foreground"
  >
    <summary class="cursor-pointer list-none px-2.5 py-1.5 font-mono text-xs hover:bg-muted/40">
      unhandled session update: ${computed(() => entry.value.sessionUpdate)}
    </summary>
    <pre
      class="max-h-64 overflow-auto border-t p-2 font-mono text-[11px]"
    ><code>${computed(() => JSON.stringify(entry.value.raw, null, 2))}</code></pre>
  </details>`;
}

/**
 * Dispatch on the entry's kind EXACTLY ONCE, outside any reactive scope.
 *
 * This must not be a computed. Nisli marks downstream observers dirty by
 * propagating through the computed chain rather than by comparing values, so a
 * computed that touches `entry` at all — even one that only reads `entry.kind`
 * and returns the same string every time — re-runs on every streamed chunk,
 * rebuilding this subtree and destroying text selection, scroll anchoring, and
 * open `<details>` state dozens of times a second.
 *
 * Reading once is safe because the kind of a given `entry.id` never changes:
 * the reducer mints a new id whenever it starts a different kind of entry, and
 * `each()` keys on that id, so a kind change arrives as a new key with a fresh
 * `templateFn` call. `untrack` makes the non-subscription explicit rather than
 * incidental — this function is called from inside `each()`'s reconcile effect.
 */
function renderEntry(entry: ReadonlySignal<TranscriptEntry>): TemplateResult {
  // `untrack` returns void in core, so the read is captured into a local.
  let kind!: TranscriptEntry['kind'];
  untrack(() => {
    kind = entry.value.kind;
  });

  switch (kind) {
    case 'message':
      return renderMessage(entry as Entry<'message'>);
    case 'thought': {
      const thought = entry as Entry<'thought'>;
      return html`${AcpThought({
        content: computed(() => thought.value.content),
        streaming: computed(() => thought.value.streaming),
      })}`;
    }
    case 'tool-call': {
      const tool = entry as Entry<'tool-call'>;
      return html`${AcpToolCall({ call: computed(() => tool.value.call) })}`;
    }
    case 'plan': {
      const plan = entry as Entry<'plan'>;
      return html`${AcpPlan({ entries: computed(() => plan.value.entries) })}`;
    }
    case 'unknown':
      return renderUnknown(entry as Entry<'unknown'>);
    default: {
      // Exhaustiveness guard: adding a TranscriptEntry kind without a renderer
      // is a build error, not a blank row.
      const unreachable: never = kind;
      void unreachable;
      return renderUnknown(entry as Entry<'unknown'>);
    }
  }
}

export type AcpTranscriptProps = {
  entries?: TranscriptEntry[];
  /** Shown when there are no entries yet. */
  empty?: string;
  className?: string;
};

export const AcpTranscript = component<AcpTranscriptProps>(
  'ui-acp-transcript',
  (props, host) => {
    transparentHost(host);

    const entries: ReadonlySignal<TranscriptEntry[]> = computed(() => props.entries.value ?? []);
    const classes = computed(() => cn('flex min-w-0 flex-col gap-3', props.className.value));

    return html`<div data-slot="acp-transcript" class="${classes}">
      ${computed(() =>
        entries.value.length === 0
          ? html`<div
              data-slot="acp-transcript-empty"
              class="px-3 py-8 text-center text-sm text-muted-foreground"
            >
              ${props.empty.value ?? 'No messages yet.'}
            </div>`
          : null,
      )}
      ${each(
        entries,
        (entry) => entry.id,
        (entry) => renderEntry(entry),
      )}
    </div>`;
  },
  { attrs: { empty: 'string', className: 'string' } },
);
