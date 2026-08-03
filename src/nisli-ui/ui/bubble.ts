/**
 * ui/bubble.ts — Bubble.
 *
 * Ported from new-york-v4/ui/bubble.tsx (shadcn/ui, MIT — https://github.com/shadcn-ui/ui)
 * as Nisli custom elements. A chat bubble (the coloured message body) with
 * variants and start/end alignment, plus a reactions pill. Pure presentation:
 * the cv() variant maps and data-slot / data-variant / data-align / data-side
 * hooks are verbatim.
 *
 * Elements: ui-bubble-group / ui-bubble / ui-bubble-content / ui-bubble-reactions.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { children, component, computed, html, type TemplateResult } from '@nisli/core';
import { cn, cv, transparentHost } from '../lib/utils.js';

export type BubbleGroupProps = {
  className?: string;
  children?: string | TemplateResult;
};

export const BubbleGroup = component<BubbleGroupProps>('ui-bubble-group', (props, host) => {
  transparentHost(host);
  const className = props.className;
  const classes = computed(() => cn('flex min-w-0 flex-col gap-2', className.value));
  return html`<div data-slot="bubble-group" class="${classes}">${children()}</div>`;
}, {
  attrs: {
    className: 'string',
  },
});

// ── ui-bubble ────────────────────────────────────────────────────────

export const bubbleVariants = cv(
  'group/bubble relative flex w-fit max-w-[80%] min-w-0 flex-col gap-1 group-data-[align=end]/message:self-end data-[align=end]:self-end data-[variant=ghost]:max-w-full',
  {
    variants: {
      variant: {
        default:
          '**:data-[slot=bubble-content]:bg-primary **:data-[slot=bubble-content]:text-primary-foreground [&_[data-slot=bubble-content]:is(button,a):hover]:bg-primary/80',
        secondary:
          '**:data-[slot=bubble-content]:bg-secondary **:data-[slot=bubble-content]:text-secondary-foreground [&_[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)]',
        muted:
          '**:data-[slot=bubble-content]:bg-muted [&_[data-slot=bubble-content]:is(button,a):hover]:bg-[color-mix(in_oklch,var(--muted),var(--foreground)_5%)]',
        tinted:
          '**:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)] **:data-[slot=bubble-content]:text-foreground dark:**:data-[slot=bubble-content]:bg-[oklch(from_var(--primary)_0.3_calc(c*0.4)_h)] [&_[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.88_calc(c*0.5)_h)] dark:[&_[data-slot=bubble-content]:is(button,a):hover]:bg-[oklch(from_var(--primary)_0.35_calc(c*0.5)_h)]',
        outline:
          '**:data-[slot=bubble-content]:border-border **:data-[slot=bubble-content]:bg-background [&_[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&_[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&_[data-slot=bubble-content]:is(button,a):hover]:bg-input/30',
        ghost:
          'border-none **:data-[slot=bubble-content]:rounded-none **:data-[slot=bubble-content]:bg-transparent **:data-[slot=bubble-content]:p-0 [&_[data-slot=bubble-content]:is(button,a):hover]:bg-muted [&_[data-slot=bubble-content]:is(button,a):hover]:text-foreground dark:[&_[data-slot=bubble-content]:is(button,a):hover]:bg-muted/50',
        destructive:
          '**:data-[slot=bubble-content]:bg-destructive/10 **:data-[slot=bubble-content]:text-destructive dark:**:data-[slot=bubble-content]:bg-destructive/20 [&_[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/20 dark:[&_[data-slot=bubble-content]:is(button,a):hover]:bg-destructive/30',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type BubbleVariant =
  | 'default'
  | 'secondary'
  | 'muted'
  | 'tinted'
  | 'outline'
  | 'ghost'
  | 'destructive';

export type BubbleProps = {
  variant?: BubbleVariant;
  align?: 'start' | 'end';
  className?: string;
  children?: string | TemplateResult;
};

export const Bubble = component<BubbleProps>('ui-bubble', (props, host) => {
  transparentHost(host);
  const variant = props.variant;
  const align = props.align;
  const className = props.className;
  const classes = computed(() => cn(bubbleVariants({ variant: variant.value ?? 'default' }), className.value));
  return html`<div
    data-slot="bubble"
    data-variant="${computed(() => variant.value ?? 'default')}"
    data-align="${computed(() => align.value ?? 'start')}"
    class="${classes}"
  >${children()}</div>`;
}, {
  attrs: {
    variant: 'string',
    align: 'string',
    className: 'string',
  },
});

// ── ui-bubble-content ────────────────────────────────────────────────

export type BubbleContentProps = {
  className?: string;
  children?: string | TemplateResult;
};

export const BubbleContent = component<BubbleContentProps>('ui-bubble-content', (props, host) => {
  transparentHost(host);
  const className = props.className;
  const classes = computed(() =>
    cn(
      'w-fit max-w-full min-w-0 overflow-hidden rounded-xl border border-transparent px-3 py-2 text-sm leading-relaxed wrap-break-word group-data-[align=end]/bubble:self-end [button]:text-left [button,a]:transition-colors [button,a]:outline-none [button,a]:focus-visible:border-ring [button,a]:focus-visible:ring-3 [button,a]:focus-visible:ring-ring/50',
      className.value,
    ),
  );
  return html`<div data-slot="bubble-content" class="${classes}">${children()}</div>`;
}, {
  attrs: {
    className: 'string',
  },
});

// ── ui-bubble-reactions ──────────────────────────────────────────────

export const bubbleReactionsVariants = cv(
  'absolute z-10 flex w-fit shrink-0 items-center justify-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-sm ring-3 ring-card has-[button]:p-0',
  {
    variants: {
      side: {
        top: 'top-0 -translate-y-3/4',
        bottom: 'bottom-0 translate-y-3/4',
      },
      align: {
        start: 'left-3',
        end: 'right-3',
      },
    },
    defaultVariants: { side: 'bottom', align: 'end' },
  },
);

export type BubbleReactionsProps = {
  side?: 'top' | 'bottom';
  align?: 'start' | 'end';
  className?: string;
  children?: string | TemplateResult;
};

export const BubbleReactions = component<BubbleReactionsProps>(
  'ui-bubble-reactions',
  (props, host) => {
    transparentHost(host);
    const side = props.side;
    const align = props.align;
    const className = props.className;
    const classes = computed(() =>
      cn(
        bubbleReactionsVariants({ side: side.value ?? 'bottom', align: align.value ?? 'end' }),
        className.value,
      ),
    );
    return html`<div
      data-slot="bubble-reactions"
      data-align="${computed(() => align.value ?? 'end')}"
      data-side="${computed(() => side.value ?? 'bottom')}"
      class="${classes}"
    >${children()}</div>`;
  },
  {
    attrs: {
      side: 'string',
      align: 'string',
      className: 'string',
    },
  },
);
