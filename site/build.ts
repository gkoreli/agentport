import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string };

const shared = {
  outdir: join(here, 'public'),
  bundle: true,
  target: 'es2022',
  minify: true,
  logLevel: 'info',
  define: { __AGENTPORT_VERSION__: JSON.stringify(version) },
} as const;

// Our own two demo surfaces. `inkwell.html` and `tasker.html` load these with
// `<script type="module">`, and they import `connect.ts` from SOURCE — esbuild
// inlines it here, so the shape of the published `connect.js` artifact is
// independent of them.
await esbuild.build({
  ...shared,
  entryPoints: [join(here, 'src/inkwell.ts'), join(here, 'src/tasker.ts')],
  format: 'esm',
});

/**
 * `connect.js` is a different kind of artifact from the two above, and building
 * it the same way was a shipped bug for as long as it has existed.
 *
 * It is the ONE file a stranger's website loads, with the tag the README puts
 * above everything else:
 *
 *     <script src="https://.../connect.js"></script>
 *
 * That is a CLASSIC script, and a classic script is parsed under the Script
 * goal, where a top-level `export` is a SyntaxError. Built as ESM the whole
 * file failed to parse, so `globalThis.AgentPort` was never assigned and the
 * documented `AgentPort.connect(...)` on the next line threw
 * `ReferenceError: AgentPort is not defined`. Every visitor, every site.
 *
 * `type="module"` does not rescue it either: module scripts are fetched in
 * CORS mode and the Worker sends no `Access-Control-Allow-Origin`. IIFE fixes
 * both at once — it parses as a classic script, and classic scripts are
 * fetched no-cors, so the missing header stops mattering. The global is
 * assigned explicitly at the bottom of `connect.ts`, so no `globalName` is
 * needed.
 *
 * Why nobody caught it: nothing we ship loads this file. Our surfaces bundle
 * the source, and the landing page shows the tag inside a `<pre>` — rendered
 * as documentation, never executed. This is NORTH-STAR requirement 6 exactly:
 * a property of the front door that everyone working here is structurally
 * unable to stand in front of.
 */
await esbuild.build({
  ...shared,
  entryPoints: [join(here, 'src/connect.ts')],
  format: 'iife'
});

/**
 * The build refuses to emit a `connect.js` a script tag cannot run.
 *
 * Deliberately narrow. NORTH-STAR is right that you cannot assert your way to
 * a good front door, because an assertion encodes what we already believe the
 * path is — so this asserts nothing about the fallback ladder, the wallet, or
 * what a visitor sees. It checks one property OF THE ARTIFACT: that it parses
 * under the same goal the documented tag parses it under. `Script` is that
 * goal, which is why this is a real check and not a spelling test on the
 * bundle.
 *
 * It lives in the build rather than beside the other checks because it must
 * not be forgettable: `npm run deploy` is build-then-publish, so a broken
 * artifact now fails before it can reach the URL in the README.
 */
const built = readFileSync(join(here, 'public/connect.js'), 'utf8');
try {
  new Script(built);
} catch (err) {
  console.error(
    `\nconnect.js does not parse as a classic script, so the README's own script tag cannot run it:\n  ${
      (err as Error).message
    }\n`,
  );
  process.exit(1);
}
console.log('connect.js parses under the Script goal, as the documented <script src> requires');
