/**
 * ui/acp-content.ts — ACP content blocks.
 *
 * Renders a `ContentBlock[]` — the shared MCP/ACP content shape that appears in
 * message chunks, thought chunks, and tool-call output. Every other ACP
 * component delegates block rendering here so the five block types are handled
 * in exactly one place.
 *
 * Elements: ui-acp-content.
 *
 * SECURITY: block text is rendered as TEXT, never as HTML, and never as
 * markdown-with-raw-HTML. Agent output and tool results are untrusted data —
 * a tool result is a channel an attacker controls. If you add markdown
 * rendering, sanitize after parsing and keep `resource_link` hrefs restricted
 * to schemes you trust.
 *
 * This file was copied into your project by `nisli-ui` — you own it.
 */

import { component, computed, each, html, untrack, type ReadonlySignal } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import {
  blockText,
  type AudioBlock,
  type ContentBlock,
  type EmbeddedResourceBlock,
  type ImageBlock,
  type ResourceLinkBlock,
  type TextBlock,
} from '../../lib/acp-protocol.js';

/** Data URI for an inline image/audio block. */
function dataUri(block: { data: string; mimeType: string }): string {
  return `data:${block.mimeType};base64,${block.data}`;
}

/**
 * Pick the element for this block ONCE, outside any reactive scope; every
 * VALUE inside it is a computed.
 *
 * The structural read must not be reactive. Core marks downstream observers
 * dirty by propagating through the computed chain rather than by comparing
 * values, so even a computed that only reads `block.type` — and returns the
 * same string forever — re-runs on every streamed token and rebuilds this
 * node, destroying text selection and breaking find-in-page mid-stream.
 *
 * Reading once is safe because the caller keys each block on `index:type`, so
 * a block whose type changes arrives as a new key and a fresh call here.
 */
function renderBlock(block: ReadonlySignal<ContentBlock>) {
  let type!: ContentBlock['type'];
  untrack(() => {
    type = block.value.type;
  });
  const as = <T extends ContentBlock>() => block.value as T;

  return html`${(() => {
    switch (type) {
      case 'text':
        return html`<div data-slot="acp-content-text" class="text-sm whitespace-pre-wrap wrap-break-word"
          >${computed(() => as<TextBlock>().text)}</div
        >`;

      case 'image':
        return html`<img
          data-slot="acp-content-image"
          class="max-h-96 w-auto max-w-full rounded-md border"
          src="${computed(() => dataUri(as<ImageBlock>()))}"
          alt="${computed(() => as<ImageBlock>().uri ?? 'Agent image output')}"
        />`;

      case 'audio':
        return html`<audio
          data-slot="acp-content-audio"
          class="w-full"
          controls
          src="${computed(() => dataUri(as<AudioBlock>()))}"
        ></audio>`;

      case 'resource_link':
        return html`<a
          data-slot="acp-content-resource-link"
          class="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs hover:bg-muted"
          href="${computed(() => as<ResourceLinkBlock>().uri)}"
          title="${computed(() => {
            const value = as<ResourceLinkBlock>();
            return value.description ?? value.uri;
          })}"
          rel="noreferrer noopener"
          >${computed(() => {
            const value = as<ResourceLinkBlock>();
            return value.title ?? value.name;
          })}</a
        >`;

      case 'resource':
        return html`<pre
          data-slot="acp-content-resource"
          class="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs"
        ><code>${computed(() => {
          const { resource } = as<EmbeddedResourceBlock>();
          return 'text' in resource ? resource.text : `${resource.uri} (binary)`;
        })}</code></pre>`;

      default:
        // A block type added after this file was copied. Show that something
        // arrived rather than rendering an empty row.
        return html`<div
          data-slot="acp-content-unknown"
          class="rounded-md border border-dashed px-2 py-1 font-mono text-xs text-muted-foreground"
        >
          unsupported content block: ${type}
        </div>`;
    }
  })()}`;
}

export type AcpContentProps = {
  content?: ContentBlock[];
  className?: string;
};

export const AcpContent = component<AcpContentProps>(
  'ui-acp-content',
  (props, host) => {
    transparentHost(host);
    const blocks = computed(() => props.content.value ?? []);
    const classes = computed(() => cn('flex min-w-0 flex-col gap-2', props.className.value));

    return html`<div data-slot="acp-content" class="${classes}">
      ${each(
        blocks,
        // Blocks are positional and streaming text merges in place, so the
        // index is the identity — keying by content would rebuild every token.
        // The type is part of the key so that a block whose type changes at a
        // given index remounts, which is what lets renderBlock read the type
        // once instead of reactively.
        (block, index) => `${index}:${block.type}`,
        (block) => renderBlock(block),
      )}
    </div>`;
  },
  { attrs: { className: 'string' } },
);

/** Plain-text flattening of a block list, for titles and copy affordances. */
export function contentToText(content: readonly ContentBlock[] | undefined): string {
  return (content ?? []).map(blockText).join('');
}
