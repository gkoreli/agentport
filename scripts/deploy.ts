/**
 * The one way to deploy, with two deliberate callers:
 *
 *   npm run deploy       — a person: bump the site version and commit it
 *   npm run deploy:ci    — GitHub: deploy the already-versioned commit
 *
 * The build-and-deploy body is shared. CI must not manufacture a commit from
 * a runner, while a local deploy must leave an attributable version behind.
 * Keeping that difference as one explicit mode avoids a second set of raw
 * Wrangler commands drifting into the workflow.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd: string) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();

const args = process.argv.slice(2);
const ci = args.length === 1 && args[0] === '--ci';
if (!ci && args.length > 0) {
  throw new Error(`usage: npm run deploy${args.length > 0 ? ' or npm run deploy:ci' : ''}`);
}

// CI authenticates Wrangler with a token from the protected `production`
// environment. When that secret is missing the deploy still RUNS — Wrangler
// fails several minutes later, inside its own auth flow, with a message about
// credentials rather than about this repository's configuration. That is how
// every release here came to be performed by hand: the automation was one
// unset secret away from working and never said so. Name the cause instead.
if (ci && !process.env['CLOUDFLARE_API_TOKEN']) {
  throw new Error(
    'CLOUDFLARE_API_TOKEN is not set, so this runner cannot deploy.\n' +
      'It belongs to the protected `production` environment, beside the\n' +
      'CLOUDFLARE_ACCOUNT_ID variable that is already there:\n\n' +
      '  gh secret set CLOUDFLARE_API_TOKEN --env production\n\n' +
      'Use a dedicated Cloudflare API token (Edit Cloudflare Workers), never\n' +
      "the local Wrangler OAuth session — it is interactive and it expires.\n" +
      'See docs/RELEASING.md, "Cloudflare authentication".',
  );
}

if (!ci) run('npm version patch --no-git-tag-version');
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// A local deploy has the freshly bumped version. CI cannot mutate the tagged
// source, so append the commit identity to the same root version instead.
// Every panel still names the exact code Cloudflare is serving.
if (ci) process.env['AGENTPORT_BUILD_VERSION'] = `${version}+${out('git rev-parse --short HEAD')}`;

run('npm run site:build');
run('npm run wallet:build');
run('npx wrangler deploy');
run('npx wrangler -c wrangler.wallet.toml deploy');

if (!ci) {
  execSync('git add package.json package-lock.json');
  run(`git commit -m "release: v${version}"`);
}
console.log(`\nDeployed ${process.env['AGENTPORT_BUILD_VERSION'] ?? `v${version}`} (${out('git rev-parse --short HEAD')})`);
