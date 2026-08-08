import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { webcrypto } from 'node:crypto';

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
 * The build refuses to emit a `connect.js` that cannot do what the README says
 * it does.
 *
 * Two properties, and the second is the one the first version of this check
 * was missing. Parsing proves the SyntaxError is gone; it says nothing about
 * whether `AgentPort` still comes into existence, so deleting the assignment
 * at the bottom of `connect.ts` would have passed a green build and broken the
 * front door again in exactly the same way. A guard with a hole where the bug
 * was is not a guard.
 *
 * Deliberately still narrow. NORTH-STAR is right that you cannot assert your
 * way to a good front door, because an assertion encodes what we already
 * believe the path is — so this asserts nothing about the fallback ladder, the
 * wallet, the relay, or what a visitor sees. It runs the file the way a
 * classic `<script src>` runs it and asks the one question the next line of
 * the README asks: is `AgentPort.connect` there.
 *
 * The stub below is minimal ON PURPOSE. It is not an attempt to simulate a
 * browser — if `connect.ts` ever needs more of one just to reach the end of
 * its own module body, that is worth failing the build over. This file is
 * loaded into strangers' pages, so heavy work at module load is a defect
 * whoever adds it should have to look at.
 *
 * It lives in the build rather than beside the other checks because it must
 * not be forgettable: `npm run deploy` is build-then-publish, so a broken
 * artifact now fails before it can reach the URL in the README.
 */
const built = readFileSync(join(here, 'public/connect.js'), 'utf8');

const fail = (why: string, detail: string): never => {
  console.error(`\nconnect.js cannot serve the integration the README documents — ${why}:\n  ${detail}\n`);
  process.exit(1);
};

let script: Script;
try {
  // `Script` is the Script goal: exactly what `<script src>` without
  // `type="module"` uses, and where a top-level `export` is a SyntaxError.
  script = new Script(built);
} catch (err) {
  fail("it does not parse as a classic script, so the README's own tag cannot run it", (err as Error).message);
}

const element = () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, remove() {} });
const page: Record<string, unknown> = {
  console,
  location: { href: 'https://stranger.test/', origin: 'https://stranger.test', pathname: '/' },
  document: {
    currentScript: null,
    scripts: [],
    head: element(),
    documentElement: element(),
    createElement: element,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener() {},
  },
  navigator: { userAgent: 'build-check' },
  addEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  crypto: webcrypto,
  TextEncoder,
  TextDecoder,
  URL,
  URLSearchParams,
};
page['window'] = page;
page['self'] = page;
page['globalThis'] = page;

try {
  script!.runInContext(createContext(page));
} catch (err) {
  fail('it throws while a script tag is still loading it', (err as Error).message);
}

const exposed = page['AgentPort'] as { connect?: unknown } | undefined;
if (typeof exposed?.connect !== 'function') {
  fail(
    'it runs but never defines the global the README calls on the next line',
    `typeof AgentPort = ${typeof exposed}, typeof AgentPort.connect = ${typeof exposed?.connect}`,
  );
}

console.log('connect.js parses, runs, and defines AgentPort.connect — the integration the README documents');
