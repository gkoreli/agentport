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
