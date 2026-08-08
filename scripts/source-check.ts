/**
 * Source hygiene that no other gate can see.
 *
 * A NUL byte reached `packages/relay/src/core.ts` through a scripted edit and
 * survived everything: `tsc` accepted it (it is a legal character in a string
 * literal), 146 e2e checks passed (it worked fine as a map-key separator), and
 * all five typecheck projects were clean. It was visible only because git
 * printed `Bin 27860 -> 29067` in a merge summary someone happened to read —
 * and once a file is binary to git, every future diff and review of it is too.
 *
 * That is the shape this repo keeps finding: a property everybody assumes,
 * enforced nowhere, in a place nothing was built to look. Every agent working
 * here edits with scripted replacements, so an invisible control character is
 * a recurring hazard rather than one person's slip.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', '.git', 'dist', '.claude', 'public']);
const TEXT = /\.(ts|tsx|js|mjs|json|md|css|html|service)$/;

/**
 * Control characters that are never deliberate.
 *
 * Tab, newline and carriage return obviously belong. ESC does too, and finding
 * that out is why this list is narrower than the first draft: the CLIs colour
 * their own output, so ESC is intentional in connect-cli.ts, and the first run
 * flagged it. A different red is not evidence (rule 6) — the check
 * was reaching past the property it could defend.
 *
 * What is left is the set that is never typed on purpose and that breaks
 * git's text handling when it appears, NUL above all.
 */
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/;

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): void => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (TEXT.test(entry.name)) yield full;
  }
}

console.log('source hygiene');
const offenders: { file: string; at: number }[] = [];
let scanned = 0;
for await (const file of walk(root)) {
  scanned++;
  const text = await readFile(file, 'utf8');
  const found = FORBIDDEN.exec(text);
  if (found) offenders.push({ file: relative(root, file), at: found.index });
}

check(`scanned enough of the tree to mean something (${scanned} files)`, scanned > 50, scanned);
check('no source file carries an invisible control character', offenders.length === 0, offenders.slice(0, 5));

console.log(failures === 0 ? '\nsource hygiene passed' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
