/**
 * Landed is not shipped, and this makes the difference answerable by one
 * command.
 *
 * AGENTS.md says it plainly: everything in "State of things" describes `main`,
 * while the front door a stranger meets is whatever the last `npm run deploy`
 * published. Requirement 6 is about people who have not arrived yet, so from
 * the only perspective it cares about, a fix that is landed and unreleased is
 * not a fix. Until now the only way to know which of the two you were looking
 * at was to remember.
 *
 * Two artifacts, chosen because they are the two a stranger actually touches:
 *
 *   /connect.js  the one file a third-party page loads. Compared by bytes
 *                against the local build, because "the deployed one is
 *                probably fine" is exactly the belief that shipped a
 *                `connect.js` no classic script tag could parse.
 *   /pair        where `npx @gkoreli/agentport` sends someone. A stranger has
 *                no extension, so this page must name a route that works
 *                without one — the hosted wallet origin.
 *
 * It also asks whether the landing page's snippet is the one this tree
 * publishes, using the snippet's own `data-relay` value rather than a literal.
 *
 * THE FAILURE THIS CHECK IS FOR is not a bug. "Deployed lags local build" is
 * the ordinary state of an unreleased change, and it is reported as exactly
 * that, distinct from a deployment that cannot be reached at all. Both exit
 * non-zero — a check that cannot see its subject must never report green
 * (AGENTS.md, rule 7: a check that skips itself when its subject is
 * unavailable is an anti-check) — but they exit differently, because one means
 * "deploy" and the other means "something is wrong with the deployment".
 *
 * WHERE IT RUNS. The release path, after `wrangler deploy`, so it verifies what
 * was just published — not per-PR CI, where it would fail on every unreleased
 * change by design.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSite, repoRoot } from './lib/harness.js';
import { DEPLOYED_ORIGIN, landingSnippet } from './lib/snippet.js';

/** Cloudflare answers in tens of milliseconds; ten seconds is already a fault. */
const FETCH_DEADLINE_MS = 10_000;

/** The deployment could not be read at all — never the same as "out of date". */
class Unreachable extends Error {}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function fetchText(path: string): Promise<string> {
  const url = `${DEPLOYED_ORIGIN}${path}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(FETCH_DEADLINE_MS), redirect: 'follow' });
  } catch (err) {
    throw new Unreachable(`${url} could not be fetched: ${(err as Error).message}`);
  }
  if (!response.ok) throw new Unreachable(`${url} answered HTTP ${response.status}`);
  try {
    return await response.text();
  } catch (err) {
    throw new Unreachable(`${url} answered but its body could not be read: ${(err as Error).message}`);
  }
}

/** Reasons the deployment is behind this tree. Each is actionable by deploying. */
const lags: string[] = [];
const ok = (label: string): void => console.log(`  ok   ${label}`);
const lag = (label: string, detail: string): void => {
  console.log(`  LAGS ${label}\n         ${detail}`);
  lags.push(label);
};

async function main(): Promise<void> {
  console.log(`checking ${DEPLOYED_ORIGIN} against this working tree\n`);

  console.log('1. connect.js is comparable by bytes');
  /**
   * `scripts/deploy.ts` stamps `AGENTPORT_BUILD_VERSION` into the browser
   * bundles, and today `connect.ts` contains nothing that reads it — which is
   * the only reason a byte comparison against a CI-built deployment means
   * anything. That is a property of the source, not a promise, so it is
   * measured rather than assumed: two builds under different stamps must be
   * identical. If someone gives `connect.js` a version string, this fails here
   * with something to act on instead of reporting a permanent phantom lag.
   */
  await buildSite({ AGENTPORT_BUILD_VERSION: '0.0.0-probe-a' });
  const probeA = sha256(await readFile(join(repoRoot, 'site/public/connect.js'), 'utf8'));
  await buildSite({ AGENTPORT_BUILD_VERSION: '0.0.0-probe-b' });
  const probeB = sha256(await readFile(join(repoRoot, 'site/public/connect.js'), 'utf8'));
  if (probeA !== probeB) {
    console.error(
      '\nconnect.js now embeds the build version stamp, so its bytes differ between a local\n' +
        'build and the CI build that was deployed. This check compares bytes and would report\n' +
        'a permanent phantom lag; teach it the deployed stamp before trusting it again.\n',
    );
    process.exit(3);
  }
  ok('connect.js is independent of the build version stamp');

  // The comparison build: the same command `npm run deploy` runs.
  await buildSite();
  const [localConnect, localPair, localIndex] = await Promise.all([
    readFile(join(repoRoot, 'site/public/connect.js'), 'utf8'),
    readFile(join(repoRoot, 'site/public/pair.html'), 'utf8'),
    readFile(join(repoRoot, 'site/public/index.html'), 'utf8'),
  ]);

  console.log('\n2. the deployed artifacts');
  const deployedConnect = await fetchText('/connect.js');
  const localHash = sha256(localConnect);
  const deployedHash = sha256(deployedConnect);
  if (localHash === deployedHash) {
    ok(`/connect.js is this build (sha256 ${localHash.slice(0, 12)}…)`);
  } else {
    lag(
      '/connect.js is not the file this tree builds',
      `deployed sha256 ${deployedHash.slice(0, 12)}… (${deployedConnect.length} bytes), ` +
        `local ${localHash.slice(0, 12)}… (${localConnect.length} bytes)`,
    );
  }

  /**
   * The route, not the markup: a stranger arriving from `npx @gkoreli/agentport`
   * has no extension, and a pairing page that only waits for one is a dead end.
   * The property is that the page names the hosted wallet; how it says so is
   * free to change.
   */
  const published = landingSnippet(localIndex).tag.attributes;
  const walletHost = new URL(published.get('data-wallet') ?? 'https://invalid.invalid').host;
  if (!localPair.includes(walletHost)) {
    console.error(
      `\nsite/public/pair.html does not link ${walletHost} either, so there is nothing to compare.\n` +
        'The extension-free pairing route is the subject of this check; restore it before running.\n',
    );
    process.exit(3);
  }
  const deployedPair = await fetchText('/pair');
  if (deployedPair.includes(walletHost)) {
    ok(`/pair offers the extension-free route via ${walletHost}`);
  } else {
    lag(
      `/pair does not name ${walletHost}, so a visitor without the extension has no route`,
      'the working tree links it; the deployed copy predates that change',
    );
  }

  const relayAttribute = `data-relay="${published.get('data-relay') ?? ''}"`;
  const deployedIndex = await fetchText('/');
  if (deployedIndex.includes(relayAttribute)) {
    ok('the landing page publishes the integration snippet from this tree');
  } else {
    lag(
      'the landing page snippet is not the one this tree publishes',
      `the deployed hero does not carry ${relayAttribute}`,
    );
  }
}

try {
  await main();
} catch (err) {
  if (err instanceof Unreachable) {
    console.error(`\nthe deployment could not be checked — ${err.message}\n`);
    console.error('This is NOT "deployed lags local": nothing was compared. Check the network and the Worker.\n');
    process.exit(2);
  }
  throw err;
}

if (lags.length === 0) {
  console.log('\nthe deployed front door is this build');
  process.exit(0);
}
console.log(`\ndeployed lags local build (${lags.length} of 3 artifacts behind) — run npm run deploy`);
process.exit(1);
