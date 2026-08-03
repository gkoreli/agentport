/**
 * Protocol-neutral content blocks for a chat transcript.
 *
 * Text is always rendered as text.  In particular, resource links are not a
 * trust boundary escape hatch: only ordinary web/mail schemes become links.
 */

import { component, computed, each, html, untrack, type ReadonlySignal } from '@nisli/core';
import { cn, transparentHost } from '../../lib/utils.js';
import type { ContentBlock } from '../../lib/chat.js';

type TextBlock = Extract<ContentBlock, { type: 'text' }>;
type ImageBlock = Extract<ContentBlock, { type: 'image' }>;
type AudioBlock = Extract<ContentBlock, { type: 'audio' }>;
type ResourceLinkBlock = Extract<ContentBlock, { type: 'resource-link' }>;
type ResourceBlock = Extract<ContentBlock, { type: 'resource' }>;

function dataUri(block: ImageBlock | AudioBlock): string {
  // ContentBlock data is bytes supplied by an agent. It is intentionally only
  // ever placed in media elements, never parsed as a document or HTML.
  return `data:${block.mimeType};base64,${block.data}`;
}

function safeLink(uri: string): string | undefined {
  try {
    const protocol = new URL(uri, document.baseURI).protocol;
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:' ? uri : undefined;
  } catch {
    return undefined;
  }
}

/** Render one stable block shape; type is part of the parent's key. */
function renderBlock(block: ReadonlySignal<ContentBlock>) {
  let type!: ContentBlock['type'];
  untrack(() => {
    type = block.value.type;
  });
  const as = <T extends ContentBlock>() => block.value as T;

  switch (type) {
    case 'text':
      return html`<div data-slot="chat-content-text" class="whitespace-pre-wrap wrap-break-word"
        >${computed(() => as<TextBlock>().text)}</div
      >`;

    case 'image':
      return html`<img
        data-slot="chat-content-image"
        class="max-h-96 w-auto max-w-full rounded-md border"
        src="${computed(() => dataUri(as<ImageBlock>()))}"
        alt="${computed(() => as<ImageBlock>().alt ?? as<ImageBlock>().uri ?? 'Image attachment')}"
      />`;

    case 'audio':
      return html`<audio
        data-slot="chat-content-audio"
        class="w-full"
        controls
        aria-label="Audio attachment"
        src="${computed(() => dataUri(as<AudioBlock>()))}"
      ></audio>`;

    case 'resource-link': {
      // This read decides an element's shape, so it is deliberately outside a
      // reactive scope. A block type/URI is immutable once inserted; the
      // transcript remounts it under a new stable key if that is not true.
      let href: string | undefined;
      untrack(() => {
        href = safeLink((block.value as ResourceLinkBlock).uri);
      });
      return href === undefined
        ? html`<span
            data-slot="chat-content-resource-link"
            data-status="unsafe"
            class="inline-flex max-w-full items-center rounded-md border border-dashed px-2 py-1 font-mono text-xs text-muted-foreground"
            title="Link unavailable: unsupported URL scheme"
            >${computed(() => as<ResourceLinkBlock>().title ?? as<ResourceLinkBlock>().name)}</span
          >`
        : html`<a
            data-slot="chat-content-resource-link"
            data-status="safe"
            class="inline-flex max-w-full items-center rounded-md border px-2 py-1 font-mono text-xs hover:bg-muted"
            href="${href}"
            rel="noreferrer noopener"
            target="_blank"
            title="${computed(() => as<ResourceLinkBlock>().description ?? as<ResourceLinkBlock>().uri)}"
            >${computed(() => as<ResourceLinkBlock>().title ?? as<ResourceLinkBlock>().name)}</a
          >`;
    }

    case 'resource':
      return html`<pre
        data-slot="chat-content-resource"
        class="max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs"
      ><code>${computed(() => {
        const resource = as<ResourceBlock>();
        return resource.text ?? `${resource.uri} (binary resource)`;
      })}</code></pre>`;
  }
}

export type ChatContentProps = {
  content?: ContentBlock[];
  className?: string;
};

/** A vertical, positional block list suitable for messages, reasoning, and output. */
export const ChatContent = component<ChatContentProps>(
  'ui-chat-content',
  (props, host) => {
    transparentHost(host);
    const content = computed(() => props.content.value ?? []);
    const classes = computed(() => cn('flex min-w-0 flex-col gap-2 text-sm', props.className.value));

    return html`<div data-slot="chat-content" class="${classes}">
      ${each(
        content,
        // Streaming updates amend a block in place. Index + type preserves its
        // DOM node while still remounting if a producer replaces its shape.
        (block, index) => `${index}:${block.type}`,
        (block) => renderBlock(block),
      )}
    </div>`;
  },
  { attrs: { className: 'string' } },
);

/** Plain text for concise labels and collapsed previews. */
export function chatContentText(content: readonly ContentBlock[] | undefined): string {
  return (content ?? [])
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'resource':
          return block.text ?? '';
        case 'resource-link':
          return block.title ?? block.name;
        default:
          return '';
      }
    })
    .join('');
}
