/**
 * ui/message.ts — Message.
 *
 * Ported from new-york-v4/ui/message.tsx (shadcn/ui, MIT — https://github.com/shadcn-ui/ui)
 * as Nisli custom elements. A chat message row (avatar + content) that flips to
 * the end for the current user. Pure presentation: class lists and data-slot /
 * data-align hooks are verbatim.
 *
 * Elements: ui-message-group / ui-message / ui-message-avatar /
 * ui-message-content / ui-message-header / ui-message-footer.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { children, component, computed, html, type TemplateResult } from '@nisli/core';
import { cn, transparentHost } from '../lib/utils.js';

export type MessageSectionProps = {
  className?: string;
  children?: string | TemplateResult;
};

function messageSection(tag: string, slot: string, base: string) {
  return component<MessageSectionProps>(
    tag,
    (props, host) => {
      transparentHost(host);
      const classes = computed(() => cn(base, props.className.value));
      return html`<div data-slot="${slot}" class="${classes}">${children()}</div>`;
    },
    { attrs: { className: 'string' } },
  );
}

export const MessageGroup = messageSection(
  'ui-message-group',
  'message-group',
  'flex min-w-0 flex-col gap-2',
);

export const MessageAvatar = messageSection(
  'ui-message-avatar',
  'message-avatar',
  'flex w-fit min-w-8 shrink-0 items-center justify-center self-end overflow-hidden rounded-full bg-muted group-has-data-[slot=message-footer]/message:-translate-y-8',
);

export const MessageContent = messageSection(
  'ui-message-content',
  'message-content',
  'flex w-full min-w-0 flex-col gap-2.5 wrap-break-word group-data-[align=end]/message:**:data-slot:self-end',
);

export const MessageHeader = messageSection(
  'ui-message-header',
  'message-header',
  'flex max-w-full min-w-0 items-center gap-1 px-3 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0',
);

export const MessageFooter = messageSection(
  'ui-message-footer',
  'message-footer',
  'flex max-w-full min-w-0 items-center px-3 text-xs font-medium text-muted-foreground group-has-data-[variant=ghost]/message:px-0 group-data-[align=end]/message:justify-end',
);

// ── ui-message (align) ───────────────────────────────────────────────

export type MessageProps = {
  align?: 'start' | 'end';
  className?: string;
  children?: string | TemplateResult;
};

export const Message = component<MessageProps>(
  'ui-message',
  (props, host) => {
    transparentHost(host);
    const classes = computed(() =>
      cn(
        'group/message relative flex w-full min-w-0 gap-2 text-sm data-[align=end]:flex-row-reverse',
        props.className.value,
      ),
    );
    return html`<div
    data-slot="message"
    data-align="${computed(() => props.align.value ?? 'start')}"
    class="${classes}"
  >${children()}</div>`;
  },
  { attrs: { align: 'string', className: 'string' } },
);
