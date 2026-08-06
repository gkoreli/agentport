/**
 * Who may pick up a parked attachment, and when one must be let go.
 *
 * There is ONE session lifecycle in this extension: every surface — a
 * page-declared `navigator.agent` session and the extension's own widget alike
 * — parks on navigation and is reclaimed by the next document, or is closed.
 * The only thing that differs is the *identity* a parked session is reclaimed
 * by, and that identity is what this module computes.
 *
 * It is deliberately free of Chrome APIs. These few rules are the consent
 * boundary written down — "the origin is the unit of consent, and a link must
 * not hand the agent to a site the user never approved" — so they live where
 * they can be asserted directly (`packages/extension/check.ts`) instead of only
 * inside the service worker's event plumbing.
 */

import type { Origin } from './bridge.js';

/**
 * The value the content script puts in a widget attachment's context to say
 * where the grant's tools came from. A grant harvested from the page's own
 * WebMCP registrations belongs to THAT document and cannot be honoured on the
 * next one, so only the extension-authored DOM toolset is reclaimable.
 */
export const WIDGET_TOOL_SOURCE_DOM = 'page-dom';

/**
 * An origin a human could have consented to.
 *
 * `port.sender.origin` degrades in two ways the reclaim key must not paper
 * over: Chrome reports the literal string `"null"` for opaque/sandboxed
 * documents, and the worker falls back to a sender URL or `'unknown://'` when
 * the browser supplies no origin at all. Both would collapse unrelated
 * documents into one bucket, so a surface on one of them is simply not
 * reclaimable — it dies with its document.
 */
export function isConsentableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.host === '') return false;
  // Reject anything that is a URL rather than a bare origin (a sender *url*
  // fallback, say): only the browser's own origin stamp round-trips.
  return url.origin === origin;
}

export interface ReclaimSubject {
  from: Origin;
  /** Browser-stamped. Never a page-supplied string. */
  origin: string;
  /** The surface name from the connect request — page-supplied. */
  name: string;
  tabId: number | undefined;
  /** `request.context.source`, authored by the content script for widgets. */
  toolSource: unknown;
}

/**
 * The single key a parked session is reclaimed by, or null when the surface is
 * not reclaimable at all and must be closed the moment its document goes away.
 *
 * The origin is in every key, so a reclaim can never cross an origin boundary
 * even before the caller's own origin check.
 */
export function reclaimKeyFor(subject: ReclaimSubject): string | null {
  if (!isConsentableOrigin(subject.origin)) return null;
  if (subject.from === 'page') {
    // A page names its own surface and re-declares the same name after a
    // navigation; that name is only ever a discriminator *within* an origin.
    return `page|${subject.origin}|${subject.name}`;
  }
  // The widget's surface name is `document.title`, which changes on nearly
  // every navigation — useless as a key. What stays the same across a
  // same-origin navigation is the tab.
  if (subject.tabId === undefined) return null;
  if (subject.toolSource !== WIDGET_TOOL_SOURCE_DOM) return null;
  return `widget|${subject.origin}|${subject.tabId}`;
}

export interface ReclaimCandidate {
  reclaimKey: string | null;
  origin: string;
  closed: boolean;
  expiresAt: number;
}

/**
 * May this parked session be handed to the document that just announced
 * itself? The key already embeds the origin; the origin is compared again on
 * purpose, so no future change to the key format can quietly widen this.
 */
export function mayReclaim(
  candidate: ReclaimCandidate,
  want: { key: string | null; origin: string; now: number },
): boolean {
  if (!want.key || candidate.reclaimKey !== want.key) return false;
  if (candidate.origin !== want.origin) return false;
  if (candidate.closed) return false;
  // Reclaim never extends a grant. An expired grant is a dead session.
  return candidate.expiresAt > want.now;
}

export interface DocumentIdentity {
  origin: string;
  tabId: number | undefined;
  /** 0 is the tab's top-level document. */
  frameId: number | undefined;
}

/**
 * A top-level document just announced itself in this tab. Anything the tab
 * still holds for a DIFFERENT origin belongs to a page the user has navigated
 * away from: the attachment must not follow the link, so it is closed rather
 * than parked.
 *
 * Only a top-frame arrival evicts, and only top-frame entries are evicted — a
 * cross-origin subframe must not be able to detach the tab's session, and a
 * subframe's own session is not evidence about where the tab went.
 */
export function leftBehindByNavigation(entry: DocumentIdentity, arriving: DocumentIdentity): boolean {
  if (arriving.frameId !== 0 || arriving.tabId === undefined) return false;
  if (entry.frameId !== 0 || entry.tabId !== arriving.tabId) return false;
  return entry.origin !== arriving.origin;
}
