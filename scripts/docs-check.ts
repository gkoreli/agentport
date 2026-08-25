/**
 * Documentation citations point at something that exists.
 *
 * An audit of every prose claim in this repo found that the single most common
 * defect was not a wrong fact — it was a `file.ts:1375` that had drifted, 27 of
 * 33 checked, several by more than a hundred lines. In a repo whose documents
 * are simultaneously the adoption surface and the design record, a citation is
 * a promise that a reader can go and look.
 *
 * WHY THIS IS NOT THE OBVIOUS CHECK. The obvious one verifies that the cited
 * file exists and has at least that many lines. It would have reported green on
 * every single one of those 27, because the file existed and was long enough —
 * a check that passes precisely when the thing it names is broken. AGENTS.md
 * rule 8: when the only available check would lie, do not write it.
 *
 * So the citation FORM changes to one a checker can actually resolve:
 *
 *   `packages/daemon/src/daemon.ts`                  a file
 *   `packages/daemon/src/daemon.ts#requestApproval`  a file and a symbol in it
 *   `packages/daemon/src/daemon.ts:1375`             REFUSED
 *
 * A symbol survives insertion, which is what line numbers cannot do, and it
 * fails exactly when the prose goes wrong: on a rename or a deletion. Line
 * numbers are refused outright rather than tolerated, because every agent here
 * edits with scripted replacements and a line number is stale the next time
 * anybody touches the file above it.
 *
 * ONE HONEST WEAKNESS, stated rather than papered over. The symbol check is
 * "does this string occur in that file", so a very generic symbol is a weak
 * citation — `ask` would still be found after `#ask` was renamed, because
 * `asks` and `askApproval` contain it. Cite something specific. The check
 * cannot tell a weak citation from a strong one and does not pretend to.
 *
 * SCOPE. Only citations beginning with a real top-level directory are checked.
 * Prose says `daemon.ts` constantly and means it loosely; a path starting
 * `packages/` is claiming precision, and this holds it to that claim.
 */
import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

/** A leading segment that means "this is a repo path", not prose. */
const ROOTS = ['packages/', 'site/', 'scripts/', 'docs/', 'examples/', 'wallet/', 'deploy/'];

/** Inline code spans only: links, headings and prose are not citations. */
const SPAN = /`([^`\n]+)`/g;
/** `path/to/file.ext`, optionally `#symbol` or the refused `:123` / `:12-30`. */
const CITATION = /^([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(?:(#[A-Za-z0-9_$.]+)|(:\d+(?:-\d+)?))?$/;
/**
 * A bare `:181`, which is how a doc cites a SECOND line in the same file it
 * just named. Caught separately because it has no path to hang off, and
 * missing it would have let eleven of these survive a green run — the check
 * reporting success over exactly the citations it exists to refuse.
 */
const CONTINUATION = /^:\d+(?:-\d+)?$/;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

async function* docs(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Dotfiles are somebody's private scratch, not a document this repo
    // publishes — `.ideas-scratch.md` is gitignored and full of deliberately
    // rough pointers. Holding notes to the standard of the design record
    // would just teach people to stop taking notes.
    if (entry.name.startsWith('.') || ['node_modules', 'dist'].includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* docs(full);
    else if (entry.name.endsWith('.md')) yield full;
  }
}

/**
 * Citations resolve against what git TRACKS, not against this disk.
 *
 * `stat()` was the obvious implementation and it made this check
 * machine-dependent: `site/public/connect.js` is a gitignored build artifact,
 * so a citation naming it passed for everyone who had run a build and failed
 * in a clean checkout. It shipped exactly that way — green locally, red in
 * CI, on a release commit.
 *
 * That is the same defect as the citation form this file exists to refuse:
 * a check that answers a question about the READER's ability to go and look,
 * using evidence only the author has. A stranger cloning this repository gets
 * the tracked tree and nothing else, so the tracked tree is the only honest
 * definition of "exists" — and a build output is never a citable location,
 * because there is no source in it to read.
 */
const tracked = new Set(
  execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(Boolean),
);
if (tracked.size === 0) throw new Error('git ls-files returned nothing; refusing to pass every citation vacuously');

const exists = (path: string): boolean => tracked.has(path);

console.log('documentation citations');

const lineNumbered: string[] = [];
const missingFile: string[] = [];
const missingSymbol: string[] = [];
let resolved = 0;

for await (const doc of docs(root)) {
  const where = relative(root, doc);
  const text = await readFile(doc, 'utf8');
  for (const [, span] of text.matchAll(SPAN)) {
    if (CONTINUATION.test(span ?? '')) {
      lineNumbered.push(`${where}: ${span}`);
      continue;
    }
    const found = CITATION.exec(span ?? '');
    if (!found) continue;
    const [, path, symbol, line] = found;
    if (!path) continue;

    // The line-number rule applies to EVERY citation, not only the ones this
    // check can resolve. `session.ts:60` claims the same precision as the
    // fully-qualified form and rots the same way; being unable to tell which
    // `session.ts` is meant makes it worse, not exempt.
    if (line) {
      lineNumbered.push(`${where}: ${path}${line}`);
      continue;
    }
    // Resolution needs an unambiguous path. Prose says `daemon.ts` loosely and
    // means it loosely; only a rooted path is claiming to be followable.
    if (!ROOTS.some((prefix) => path.startsWith(prefix))) continue;
    if (!exists(path)) {
      missingFile.push(`${where}: ${path}`);
      continue;
    }
    if (symbol) {
      const source = await readFile(join(root, path), 'utf8');
      if (!source.includes(symbol.slice(1))) {
        missingSymbol.push(`${where}: ${path}${symbol}`);
        continue;
      }
    }
    resolved++;
  }
}

check(`found citations worth checking (${resolved} resolved)`, resolved > 20, resolved);
check('every cited file exists', missingFile.length === 0, missingFile.slice(0, 8));
check('every cited symbol is still in the file it is cited from', missingSymbol.length === 0, missingSymbol.slice(0, 8));
check(
  'no citation points at a line number, which rots the next time anyone edits above it',
  lineNumbered.length === 0,
  lineNumbered,
);

console.log(failures === 0 ? '\ndocumentation citations resolve' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
