/**
 * ui/button.ts — Button.
 *
 * Ported from shadcn/ui `new-york-v4/ui/button.tsx` (MIT —
 * https://github.com/shadcn-ui/ui) as a Nisli component. Usable as a typed
 * factory (`Button({...})`) or as a plain custom element
 * (`<ui-button variant="outline">`).
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import {
  children,
  component,
  type ComponentAttrs,
  computed,
  html,
  type TemplateResult,
} from '@nisli/core';
import { cn, cv, transparentHost } from '../lib/utils.js';

export const buttonVariants = cv(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline:
          'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50',
        secondary:
          'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost:
          'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariant =
  | 'default'
  | 'destructive'
  | 'outline'
  | 'secondary'
  | 'ghost'
  | 'link';

export type ButtonSize =
  | 'default'
  | 'xs'
  | 'sm'
  | 'lg'
  | 'icon'
  | 'icon-xs'
  | 'icon-sm'
  | 'icon-lg';

export type ButtonProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  /** Invalid state forwarded to the inner button that owns aria-invalid:* classes. */
  ariaInvalid?: boolean;
  /** Merged last into the inner <button>'s class list via cn(). */
  className?: string;
  children?: string | TemplateResult;
};

// ADR 0025 item 3: opt-in attribute reactivity. Passed as component()'s second
// type argument (`typeof buttonAttrs`) so declared `disabled` narrows to
// `boolean` (ADR 0025 candidate (b)) — no `as boolean` stopgap.
const buttonAttrs = {
  variant: 'string',
  size: 'string',
  type: 'string',
  className: 'string',
  disabled: 'boolean',
  ariaInvalid: 'boolean',
} satisfies ComponentAttrs<ButtonProps>;

export const Button = component<ButtonProps, typeof buttonAttrs>('ui-button', (props, host) => {
  transparentHost(host);

  const variant = props.variant;
  const size = props.size;
  const type = props.type;
  const className = props.className;
  const disabled = computed<boolean>(() => props.disabled.value);

  const classes = computed(() =>
    cn(buttonVariants({ variant: variant.value, size: size.value }), className.value),
  );

  // ADR 0025 item 1: children() owns projection — light-DOM
  // children AND the factory `children` prop route through the one slot. The
  // captureChildren/projectChildren + onMount dance is gone.
  return html`<button
    data-slot="button"
    data-variant="${computed(() => variant.value ?? 'default')}"
    data-size="${computed(() => size.value ?? 'default')}"
    class="${classes}"
    type="${computed(() => type.value ?? 'button')}"
    disabled="${disabled}"
    aria-invalid="${computed(() => (props.ariaInvalid.value ? 'true' : undefined))}"
  >${children()}</button>`;
}, { attrs: buttonAttrs });
