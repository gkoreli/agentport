/**
 * Which origins the extension exists on, as far as a page can tell.
 *
 * Until this module, the extension announced itself to every page on the web
 * before any consent: `content.ts` injected the provider at document_start
 * everywhere, defined `navigator.agent` and the WebMCP shim, and rendered the
 * FAB — a stable, globally unique fingerprinting bit that contradicted the
 * north star verbatim ("on an undeclared site, the site does not even know an
 * agent is present"), and changed web-platform feature detection on sites that
 * branch on `document.modelContext`.
 *
 * The rule now: an origin the user has not enabled gets NOTHING page-visible.
 * The isolated-world mediator still runs there — an isolated world leaves no
 * trace a page can observe, and the session lifecycle needs its port announce
 * (a tab arriving on a new origin is what closes the attachment the tab left
 * behind) — but it injects nothing, renders nothing, and refuses page traffic.
 *
 * The page-world provider is injected by BROWSER REGISTRATION
 * (`chrome.scripting.registerContentScripts`, MAIN world, document_start) for
 * enabled origins only, not by the mediator appending a script tag. That is
 * what preserves the one guarantee the WebMCP shim is built on: it must exist
 * before the first page script runs, and an async storage read races the
 * parser. The registration is computed here, applied in the service worker,
 * and re-synced from `storage.onChanged`, so a CDP write, the popup, and a
 * fresh install all converge through one code path.
 *
 * This file is deliberately chrome-free so `check.ts` can assert the rules
 * directly: which origins are enableable at all, and which match pattern a
 * given origin registers under.
 */

/** chrome.storage.local key holding the enabled-origin list. */
export const ENABLED_ORIGINS_KEY = 'agentport.enabled.origins.v1';

/** The one registration id for the page-world provider script. */
export const INPAGE_SCRIPT_ID = 'agentport-inpage';

/**
 * Only http(s) origins are enableable. `chrome-extension://`, `file://`,
 * `about:` and opaque origins never get a provider: the first two are not
 * websites, and an opaque origin cannot be re-identified on the next visit,
 * so an enablement recorded for it would be authority nothing can match.
 */
export function isEnableableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // An origin is scheme://host[:port] exactly — reject anything with a path,
  // query, credentials, or other decoration so the stored list holds one
  // spelling per origin and lookups cannot miss on formatting.
  return url.origin === origin;
}

export interface OriginPattern {
  /** The match pattern preferred for this origin. */
  pattern: string;
  /**
   * True when the origin carries an explicit port. Chrome match patterns have
   * historically rejected ports; when registration with `pattern` throws, the
   * applier falls back to `portBlind`, which matches every port on the host.
   * The mediator's exact-origin check keeps page traffic scoped either way —
   * the fallback's only cost is that sibling ports of an enabled localhost
   * host may see the provider object. That is a local-development shape, and
   * it is logged when it happens rather than silently widened.
   */
  portBlind?: string;
}

/** The match pattern(s) an enabled origin registers the provider under. */
export function originPattern(origin: string): OriginPattern | undefined {
  if (!isEnableableOrigin(origin)) return undefined;
  const url = new URL(origin);
  const exact = `${url.protocol}//${url.host}/*`;
  if (url.port === '') return { pattern: exact };
  return { pattern: exact, portBlind: `${url.protocol}//${url.hostname}/*` };
}

/**
 * The registration the service worker should hold for a given enabled list:
 * one registration, all enabled origins as matches, or none at all when the
 * list is empty (chrome.scripting rejects a registration with zero matches,
 * and an empty registration would be a lie about what is injected anyway).
 */
export function desiredRegistration(origins: readonly string[]): { id: string; matches: string[] } | undefined {
  const matches: string[] = [];
  for (const origin of origins) {
    const derived = originPattern(origin);
    if (derived) matches.push(derived.pattern);
  }
  if (matches.length === 0) return undefined;
  return { id: INPAGE_SCRIPT_ID, matches };
}
