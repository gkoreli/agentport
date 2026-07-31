/**
 * lib/utils.ts — shared utilities for @nisli/ui components.
 *
 * Zero-dependency ports of the ideas behind clsx and
 * class-variance-authority (both MIT), plus custom-element interop
 * helpers for Nisli components (ADR 0022).
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

// ── cn() — class name joiner ────────────────────────────────────────

export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[]
  | Record<string, boolean | null | undefined>;

/**
 * Join class values into a single class string.
 * Accepts strings, arrays, and `{ class: condition }` records; skips
 * null/undefined/false. Conflicting Tailwind utilities are not
 * deduplicated — later entries win by CSS order, so pass overrides last.
 */
export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) collect(input, out);
  return out.join(' ');
}

function collect(input: ClassValue, out: string[]): void {
  if (input == null || input === false || input === '') return;
  if (typeof input === 'string' || typeof input === 'number') {
    out.push(String(input));
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) collect(item, out);
    return;
  }
  for (const [key, on] of Object.entries(input)) {
    if (on) out.push(key);
  }
}

// ── cv() — class variants (cva-style) ───────────────────────────────

type VariantShape = Record<string, Record<string, ClassValue>>;

/** `null`/`undefined` selections fall back to `defaultVariants` (cva parity). */
export type VariantSelection<V extends VariantShape> = {
  [K in keyof V]?: keyof V[K] | null | undefined;
};

export interface VariantConfig<V extends VariantShape> {
  variants: V;
  defaultVariants?: VariantSelection<V>;
  compoundVariants?: Array<VariantSelection<V> & { class: ClassValue }>;
}

/** Extract the selection type of a `cv()` result, like cva's VariantProps. */
export type VariantProps<T> = T extends (selection?: infer S) => string
  ? Omit<NonNullable<S>, 'className'>
  : never;

/**
 * Build a variant class resolver. shadcn/ui `cva(...)` variant maps port
 * onto this one-to-one:
 *
 * ```ts
 * const buttonVariants = cv('inline-flex ...', {
 *   variants: { variant: { default: '...', outline: '...' } },
 *   defaultVariants: { variant: 'default' },
 * });
 * buttonVariants({ variant: 'outline', className: 'w-full' })
 * ```
 */
export function cv<V extends VariantShape>(
  base: ClassValue,
  config?: VariantConfig<V>,
): (selection?: VariantSelection<V> & { className?: ClassValue }) => string {
  return (selection) => {
    const classes: ClassValue[] = [base];
    if (config) {
      const chosen: Record<string, unknown> = {};
      const picked = selection as Record<string, unknown> | undefined;
      const defaults = config.defaultVariants as Record<string, unknown> | undefined;
      for (const key of Object.keys(config.variants)) {
        const value = picked?.[key] ?? defaults?.[key];
        chosen[key] = value;
        if (value != null) {
          classes.push(config.variants[key]?.[value as string]);
        }
      }
      for (const compound of config.compoundVariants ?? []) {
        const { class: compoundClass, ...match } = compound;
        const matches = Object.entries(match).every(
          ([key, value]) => chosen[key] === value,
        );
        if (matches) classes.push(compoundClass);
      }
    }
    classes.push(selection?.className);
    return cn(...classes);
  };
}

// ── Custom-element interop helpers (ADR 0022 conventions) ───────────

/**
 * Make the custom-element host layout-transparent. Every @nisli/ui
 * component calls this first in setup: the host (`<ui-button>`) carries
 * no box; all styling lives on the component's inner root element.
 */
export function transparentHost(host: HTMLElement): void {
  host.style.display = 'contents';
}

/**
 * Read a component's internal pin-state — the controlled-vs-uncontrolled
 * discriminator for the attribute-as-truth open pattern (ADR 0025 item 3). A
 * declared `'boolean'` prop is never `undefined`, so pin state is the only
 * signal of whether a factory prop is driving (controlled) vs the attribute
 * (uncontrolled). Used by overlay roots so `setOpen` skips the attribute write
 * under controlled usage and the `defaultOpen` seed skips a pinned prop.
 */
export function isPinned(host: HTMLElement, key: string): boolean {
  return (host as unknown as { _isPinned?(k: string): boolean })._isPinned?.(key) ?? false;
}

/**
 * Detach and return the host's pre-existing light-DOM child nodes. Light-DOM
 * projection is now `children()` (ADR 0025 item 1); the sole surviving use of
 * this helper is capturing child TEXT as a native initial value — `textarea`
 * and `input-group` read the returned nodes' text content once at setup (a
 * sanctioned exception, commented at each call site). Call once in setup,
 * before returning the template.
 */
export function captureChildren(host: HTMLElement): Node[] {
  const nodes = Array.from(host.childNodes);
  for (const node of nodes) host.removeChild(node);
  return nodes;
}
