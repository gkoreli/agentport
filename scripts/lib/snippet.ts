/**
 * The integration snippet, extracted from the two front doors that publish it.
 *
 * A stranger meets this project through exactly two artifacts: the README that
 * GitHub renders above everything else, and the landing page the deployed
 * Worker serves. NORTH-STAR records both failure modes this module exists to
 * make checkable — a snippet that cannot run at all, and "a landing page and a
 * README giving different instructions for the same step".
 *
 * Extraction is deliberately marker-driven rather than structural. "The first
 * `<pre>` in the file" and "the first fenced block in the README" are string
 * keys with an expiry date: a legitimate edit that adds a block above moves
 * them, and the check would then quietly test something else while still
 * reporting green (AGENTS.md, what makes a check evidence, rule 4). An
 * explicit `<!-- snippet:integration -->` marker cannot move by accident, and
 * when it is renamed or deleted the extraction throws instead of finding a
 * plausible substitute.
 *
 * Nothing here does I/O or validation. It turns two documents into the same
 * shape so a caller can execute them and compare them.
 */

/**
 * The deployment a stranger is sent to. It appears once, here, because two
 * checks need it and because a front door that names a different host in the
 * README than on the landing page is the defect this module exists to catch.
 * Changing where AgentPort is deployed changes this line and both documents.
 */
export const DEPLOYED_ORIGIN = 'https://agentport.gogakoreli.workers.dev';

/** Extraction failed: the document no longer has the shape the check reads. */
export class SnippetExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnippetExtractionError';
  }
}

export const SNIPPET_MARKER = 'snippet:integration';

export interface ScriptTag {
  /** The tag exactly as published, for reporting. */
  raw: string;
  /** Every `name="value"` on the tag. */
  attributes: Map<string, string>;
}

export interface IntegrationSnippet {
  /** Repo-relative path of the document this came from. */
  where: string;
  tag: ScriptTag;
  /**
   * Page elements the snippet's own JavaScript reaches for. The README ships
   * them beside the tag; the landing hero is an excerpt and ships none, which
   * is why the executing check gives both snippets the README's markup.
   */
  markup: string;
  /** The JavaScript a copier pastes after the tag. */
  js: string;
}

/** The text between `<!-- marker … -->` and `<!-- /marker -->`. */
function region(text: string, where: string, marker: string): string {
  const open = `<!-- ${marker}`;
  const openAt = text.indexOf(open);
  if (openAt < 0) {
    throw new SnippetExtractionError(
      `${where}: no <!-- ${marker} --> marker. The integration snippet is published here and ` +
        'is executed by `npm run snippet:check`; if it moved, move the marker with it rather ' +
        'than letting the check pass without looking at anything.',
    );
  }
  if (text.indexOf(open, openAt + open.length) >= 0) {
    throw new SnippetExtractionError(`${where}: <!-- ${marker} --> appears more than once, so the snippet is ambiguous`);
  }
  const bodyAt = text.indexOf('-->', openAt);
  if (bodyAt < 0) throw new SnippetExtractionError(`${where}: <!-- ${marker} … is never closed with -->`);
  const close = `<!-- /${marker} -->`;
  const closeAt = text.indexOf(close, bodyAt);
  if (closeAt < 0) {
    throw new SnippetExtractionError(`${where}: <!-- ${marker} --> has no matching <!-- /${marker} --> marker`);
  }
  return text.slice(bodyAt + '-->'.length, closeAt);
}

function only(matches: string[], what: string, where: string): string {
  if (matches.length !== 1) {
    throw new SnippetExtractionError(
      `${where}: expected exactly one ${what} inside the ${SNIPPET_MARKER} markers, found ${matches.length}`,
    );
  }
  return matches[0] as string;
}

/**
 * `<pre>` content is HTML-escaped on the landing page and has to come back out
 * as the source a copier would paste. `&amp;` is decoded last so an escaped
 * `&amp;lt;` cannot become a tag.
 */
function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Split a copy-paste block into the `<script …></script>` tag and the JS after it. */
function splitTag(source: string, where: string): { tag: ScriptTag; rest: string } {
  const start = source.indexOf('<script');
  const end = source.indexOf('</script>');
  if (start < 0 || end < start) {
    throw new SnippetExtractionError(`${where}: the snippet has no <script …></script> tag, so it loads nothing`);
  }
  const raw = source.slice(start, end + '</script>'.length);
  const attributes = new Map<string, string>();
  // Only the opening tag carries attributes; stopping at the first `>` keeps
  // anything in the tag's body out of the attribute map.
  const opening = raw.slice(0, raw.indexOf('>') + 1);
  for (const match of opening.matchAll(/[\s]([a-zA-Z][a-zA-Z0-9-]*)="([^"]*)"/g)) {
    attributes.set(match[1] as string, match[2] as string);
  }
  return {
    tag: { raw, attributes },
    rest: `${source.slice(0, start)}${source.slice(end + '</script>'.length)}`.trim(),
  };
}

/** The hero snippet on the deployed landing page. */
export function landingSnippet(html: string, where = 'site/public/index.html'): IntegrationSnippet {
  const body = region(html, where, SNIPPET_MARKER);
  const block = only([...body.matchAll(/<pre>([\s\S]*?)<\/pre>/g)].map((m) => m[1] as string), '<pre> block', where);
  const { tag, rest } = splitTag(unescapeHtml(block), where);
  return { where, tag, markup: '', js: rest };
}

/** The first code block in the README — the one GitHub renders above everything else. */
export function readmeSnippet(md: string, where = 'README.md'): IntegrationSnippet {
  const body = region(md, where, SNIPPET_MARKER);
  const fenced = (language: string): string =>
    only(
      [...body.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1] as string),
      '```' + language + ' block',
      where,
    );
  const { tag, rest } = splitTag(fenced('html'), where);
  return { where, tag, markup: rest, js: fenced('js').trim() };
}
