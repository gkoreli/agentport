/**
 * The documented integration is EXECUTED, not believed.
 *
 * NORTH-STAR requirement 6 — "integration is one call" — is the only one that
 * binds where nobody working here ever stands, and it has now broken twice at
 * the same twelve lines. The first time the call named a global nothing
 * defines. The second time the script tag could not parse the artifact it
 * loads. Both were true of the published snippet for months, because nothing
 * we ship ever runs it: the README is prose and the landing page renders its
 * copy inside a `<pre>`.
 *
 * This check runs it. It takes the snippet from both front doors, holds them
 * to each other, and drives the landing page's own configuration through the
 * built `connect.js` until a relay sees a socket and a frame.
 *
 * WHAT IT DELIBERATELY DOES NOT DO.
 *
 * - It does not re-litigate parsing or the global. `site/build.ts` already
 *   refuses to emit a `connect.js` that fails to parse under the Script goal
 *   or that never assigns `AgentPort`, and it does that inside the build so it
 *   cannot be forgotten. This asserts the global once, as the precondition for
 *   everything below, and adds the property that guard cannot reach: that the
 *   snippet's own `AgentPort.connect(…)` argument survives `buildGrant` and
 *   gets as far as dialling.
 * - It does not run a daemon, a wallet, or a session. "The snippet a stranger
 *   copies actually runs" ends at the relay dial; everything past it is
 *   `scripts/e2e.ts`, over real sockets, already.
 * - It never fetches the deployed `connect.js` or the deployed relay. Offline,
 *   the local build stands in for the artifact and a local `Relay` stands in
 *   for the endpoint — which is only honest because `scripts/deployed-check.ts`
 *   separately proves the deployed bytes are this build. The two halves join
 *   up: this one says the snippet runs the artifact; that one says the URL in
 *   the snippet serves the artifact.
 *
 * WHY THE POPUP IS BLOCKED HERE. `AgentPort.connect` prefers an installed
 * extension, then a popup on the wallet's own origin, and only then the
 * connect-code fallback. The first two end at a consent surface this harness
 * has no business simulating; the third is the tier that dials the relay by
 * itself, and it is reached exactly as a real browser reaches it — by
 * `window.open` returning null. The `data-wallet` value is left as published
 * (never substituted) so `connect.ts#walletUrl` validates the real one.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Window } from 'happy-dom';
import { buildGrant } from '../packages/client/src/index.js';
import { decodeFrame, toErr } from '../packages/protocol/src/index.js';
import type { Peer } from '../packages/relay/src/core.js';
import { Relay } from '../packages/relay/src/relay.js';
import { buildSite, deadline, repoRoot as root } from './lib/harness.js';
import {
  DEPLOYED_ORIGIN,
  landingSnippet,
  readmeSnippet,
  type IntegrationSnippet,
} from './lib/snippet.js';

/** Every wait here owns a deadline: a check that hangs is not a check. */
const RELAY_DEADLINE_MS = 5_000;
/**
 * Generous but bounded: `connect.js` waits up to 400ms for an extension before
 * it dials, and the dial is loopback. A snippet pointed at a host that does not
 * resolve hangs its socket rather than erroring, which is precisely the case
 * this deadline exists to turn into a failure instead of a wait.
 */
const SNIPPET_DEADLINE_MS = 10_000;

/**
 * http, not https. The published relay is `wss://`, but this harness
 * substitutes a loopback `ws://` one, and a real browser refuses `ws://` from
 * an https page. Serving the fixture over http keeps the substitution from
 * quietly testing something a browser would block.
 */
const PAGE_URL = 'http://stranger.test/';

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown): boolean => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
  return ok;
};

// A declaration, not a const arrow: only a declaration teaches control-flow
// analysis that the code after a call to it is unreachable.
function fatal(why: string, detail?: unknown): never {
  console.error(`\nsnippet:check could not run — ${why}${detail === undefined ? '' : `\n  ${String(detail)}`}\n`);
  process.exit(1);
}

/**
 * A snippet that throws is the thing being measured, and the throw happens
 * inside a page whose promises Node otherwise treats as its own: an unhandled
 * rejection from the fixture kills the process and prints the whole minified
 * bundle before any check can report. So route it to the run in flight — and
 * when nothing is in flight, it is the harness that is broken, which exits
 * loudly rather than being swallowed.
 */
let activePage: RunOutcome | undefined;
const capturePageFault = (label: string) => (reason: unknown) => {
  // `toErr`, not `instanceof Error`: the page runs in its own VM realm, so its
  // Error constructor is not this one and the instance check silently fails.
  const message = toErr(reason).message;
  if (!activePage) {
    console.error(`\nsnippet:check saw an ${label} outside a fixture page — that is a harness bug:\n  ${message}\n`);
    process.exit(1);
  }
  activePage.pageError ??= message;
};
process.on('unhandledRejection', capturePageFault('unhandled rejection'));
process.on('uncaughtException', capturePageFault('uncaught exception'));

// --- extraction and agreement ----------------------------------------------

const [landingHtml, readmeMd, connectSource] = await Promise.all([
  readFile(join(root, 'site/public/index.html'), 'utf8'),
  readFile(join(root, 'README.md'), 'utf8'),
  readFile(join(root, 'site/src/connect.ts'), 'utf8'),
]);

console.log('1. the two front doors publish the same instruction');

function extractBoth(): { landing: IntegrationSnippet; readme: IntegrationSnippet } {
  try {
    return { landing: landingSnippet(landingHtml), readme: readmeSnippet(readmeMd) };
  } catch (err) {
    // Extraction failing is never a pass. If the snippet moved or a marker was
    // renamed, this check has stopped looking at anything, and says so.
    fatal('the integration snippet could not be extracted', (err as Error).message);
  }
}
const { landing, readme } = extractBoth();

const attr = (snippet: IntegrationSnippet, name: string): string | undefined => snippet.tag.attributes.get(name);

for (const name of ['src', 'data-relay', 'data-wallet']) {
  const a = attr(landing, name);
  const b = attr(readme, name);
  check(`the landing page and the README agree on ${name}`, a !== undefined && a === b, { landing: a, readme: b });
}

const src = attr(readme, 'src');
const relay = attr(readme, 'data-relay');
const wallet = attr(readme, 'data-wallet');

check('the snippet loads connect.js from the deployed origin over https', src === `${DEPLOYED_ORIGIN}/connect.js`, src);
check(
  'the snippet names the deployed relay explicitly, so a third-party site does not fall back to its own /relay',
  relay === `${DEPLOYED_ORIGIN.replace(/^https:/, 'wss:')}/relay`,
  relay,
);
check('the snippet names the hosted wallet over https', wallet !== undefined && wallet.startsWith('https://'), wallet);
check(
  'the wallet origin the snippet publishes is the one connect.js falls back to on its own',
  wallet !== undefined && connectSource.includes(`PRODUCTION_WALLET_ORIGIN = '${wallet}'`),
  wallet,
);
check(
  'the README ships the markup its own snippet reaches for',
  /id="editor"/.test(readme.markup) && /id="connect-agent"/.test(readme.markup),
  readme.markup,
);

// --- executing them ---------------------------------------------------------

console.log('\n2. building the artifact the snippet loads');
try {
  await buildSite();
} catch (err) {
  fatal('the site build failed, so there is no connect.js to run', (err as Error).message);
}
const connectJs = await readFile(join(root, 'site/public/connect.js'), 'utf8');
check('site/build.ts produced a connect.js', connectJs.length > 1000, connectJs.length);

const relayServer = new Relay({ port: 0, sink: () => {} });
try {
  await deadline(relayServer.listening(), RELAY_DEADLINE_MS, 'the local relay never started listening');
} catch (err) {
  fatal('the local relay could not start', (err as Error).message);
}
const relayUrl = `ws://127.0.0.1:${relayServer.port}`;

/**
 * Observation, not substitution: the real `RelayCore` still decides what the
 * frame means. Wrapping its two entry points is the only way to see a socket
 * arrive — a client `hello` is not something the relay logs, and a check keyed
 * on a log line is a check with an expiry date.
 */
const core = relayServer.core;
const coreOpen = core.open.bind(core);
const coreMessage = core.message.bind(core);
let dials = 0;
const seen = new Set<Peer>();
let awaitingFrame: ((raw: string) => void) | undefined;
core.open = (peer: Peer) => {
  dials++;
  coreOpen(peer);
};
core.message = (peer: Peer, raw: string) => {
  if (!seen.has(peer)) {
    seen.add(peer);
    awaitingFrame?.(raw);
    awaitingFrame = undefined;
  }
  coreMessage(peer, raw);
};

interface RunOutcome {
  request: Record<string, unknown> | undefined;
  /** The raw first frame the relay received on a freshly dialled socket. */
  dialed?: string;
  /** What `AgentPort.connect` rejected with, if it did. */
  rejected?: string;
  /** Anything the page threw outside the connect promise. */
  pageError?: string;
  console: string;
}

/**
 * Load `connect.js` the way the snippet's tag loads it, run the snippet's own
 * JavaScript after it, and press the button the snippet binds.
 *
 * The one attribute substituted is `data-relay`, so the dial lands on a
 * loopback relay instead of the deployed one; `src` is not set at all, because
 * setting it would make happy-dom fetch the deployed file and this check must
 * run offline against the build it just produced.
 */
async function runSnippet(snippet: IntegrationSnippet, markup: string): Promise<RunOutcome> {
  const win = new Window({
    url: PAGE_URL,
    settings: {
      // The only code evaluated here is this repo's own build output and the
      // snippet extracted from this repo's own documents.
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  const doc = win.document;
  const out: RunOutcome = { request: undefined, console: '' };
  activePage = out;

  win.addEventListener('error', (event: unknown) => {
    const detail = event as { error?: unknown; message?: unknown };
    out.pageError ??= toErr(detail.error ?? detail.message ?? 'page error').message;
  });

  // A blocked popup is the documented route to the connect-code tier.
  Object.defineProperty(win, 'open', { configurable: true, writable: true, value: () => null });

  doc.body.innerHTML = markup;

  const tag = doc.createElement('script');
  for (const [name, value] of snippet.tag.attributes) {
    if (name === 'src') continue;
    tag.setAttribute(name, name === 'data-relay' ? relayUrl : value);
  }
  tag.textContent = connectJs;
  doc.head.appendChild(tag);

  const port = (win as unknown as Record<string, unknown>)['AgentPort'] as
    | { connect?: (request: Record<string, unknown>) => Promise<unknown> }
    | undefined;
  if (typeof port?.connect !== 'function') {
    out.pageError = `the tag ran but never defined AgentPort.connect (typeof AgentPort = ${typeof port})`;
    return out;
  }

  const dialed = new Promise<string>((resolve) => (awaitingFrame = resolve));
  const rejected = new Promise<string>((resolve) => {
    const real = port.connect!.bind(port);
    port.connect = (request: Record<string, unknown>) => {
      out.request ??= request;
      // Observation, not substitution: the real connect still runs, and the
      // rejection is rethrown so the page fails exactly as a copier's page does.
      return real(request).catch((err: unknown) => {
        resolve(toErr(err).message);
        throw err;
      });
    };
  });

  const body = doc.createElement('script');
  body.textContent = snippet.js;
  doc.head.appendChild(body);

  const button = doc.querySelector('#connect-agent') as unknown as { click(): void } | null;
  if (!button) {
    out.pageError ??= 'the page has no #connect-agent button for the snippet to bind';
    return out;
  }
  button.click();

  const settled = await Promise.race([
    dialed.then((raw) => ({ kind: 'dialed' as const, raw })),
    rejected.then((err) => ({ kind: 'rejected' as const, err })),
    new Promise<{ kind: 'deadline' }>((resolve) =>
      setTimeout(() => resolve({ kind: 'deadline' }), SNIPPET_DEADLINE_MS).unref?.(),
    ),
  ]);
  if (settled.kind === 'dialed') out.dialed = settled.raw;
  if (settled.kind === 'rejected') out.rejected = settled.err;

  out.console = win.happyDOM.virtualConsolePrinter.readAsString().slice(0, 1500);
  awaitingFrame = undefined;
  try {
    await deadline(win.happyDOM.close(), RELAY_DEADLINE_MS, 'the page never closed');
  } catch (err) {
    console.log(`  note  the fixture page did not close cleanly: ${(err as Error).message}`);
  }
  // Let a rejection raised by the page arrive before this run stops owning it.
  await new Promise((resolve) => setTimeout(resolve, 50));
  activePage = undefined;
  return out;
}

let section = 2;
for (const snippet of [landing, readme]) {
  console.log(`\n${++section}. ${snippet.where} — executed`);
  const before = dials;
  // Both snippets run against the README's markup: it is the only one of the
  // two that publishes any, and the hero is an excerpt of the same page.
  const outcome = await runSnippet(snippet, readme.markup);

  check(
    'the snippet called AgentPort.connect',
    outcome.request !== undefined,
    outcome.pageError ?? outcome.console,
  );

  if (outcome.request) {
    // The snippet's object was built inside the page's VM realm, and the wire
    // schemas require a plain object of THIS realm (`schema.ts` compares the
    // prototype, which is what makes `__proto__` smuggling impossible). A JSON
    // round-trip carries over exactly the data `buildGrant` reads and drops
    // the handlers it would strip anyway.
    const request = JSON.parse(JSON.stringify(outcome.request)) as {
      name?: unknown;
      tools?: unknown;
      alwaysAsk?: unknown;
      ttlMs?: unknown;
    };
    let grantError: string | undefined;
    try {
      // The same function connect.js calls before it asks anyone for anything.
      // A snippet that fails here throws in the copier's face on line one.
      buildGrant({
        surface: { name: String(request.name) },
        tools: request.tools as never,
        alwaysAsk: request.alwaysAsk as never,
        ttlMs: request.ttlMs as never,
      });
    } catch (err) {
      grantError = (err as Error).message;
    }
    check('the configuration the snippet passes builds a valid capability grant', grantError === undefined, grantError);
  }

  const dialedOk = check(
    'the snippet reaches a relay dial',
    outcome.dialed !== undefined && dials > before,
    outcome.rejected ?? outcome.pageError ?? `no socket reached ${relayUrl}; page log: ${outcome.console}`,
  );
  if (dialedOk && outcome.dialed !== undefined) {
    let firstFrame = '';
    try {
      firstFrame = decodeFrame(outcome.dialed).t;
    } catch (err) {
      firstFrame = `undecodable: ${(err as Error).message}`;
    }
    check('the relay receives a protocol handshake on that socket', firstFrame === 'hello', firstFrame);
  }
}

await relayServer.close();
console.log(failures === 0 ? '\nthe published integration snippet runs' : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
