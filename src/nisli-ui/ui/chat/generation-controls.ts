/** Generation controls for protocols that support cancelling a running turn. */

import { component, computed, html } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import { buttonVariants } from '../button.js';

export type ChatGenerationControlsProps = {
  busy?: boolean;
  onCancel?: () => void;
  className?: string;
};

/**
 * There is intentionally no pause/resume affordance. A protocol must expose
 * those capabilities before a UI can promise them.
 */
export const ChatGenerationControls = component<ChatGenerationControlsProps>(
  'ui-chat-generation-controls',
  (props, host) => {
    transparentHost(host);
    const visible = computed(() => props.busy.value && props.onCancel.value !== undefined);
    const classes = computed(() => cn('flex items-center gap-2', props.className.value));

    return html`${computed(() =>
      visible.value
        ? html`<div
            data-slot="chat-generation-controls"
            data-state="running"
            class="${classes}"
            role="toolbar"
            aria-label="Generation controls"
          >
            <button
              type="button"
              data-slot="chat-generation-stop"
              class="${buttonVariants({ variant: 'outline', size: 'sm' })}"
              @click=${() => props.onCancel.value?.()}
            >
              Stop
            </button>
          </div>`
        : null,
    )}`;
  },
  { attrs: { busy: 'boolean', className: 'string' } },
);
