/**
 * The one way to deploy: bump the patch version, build with it baked into the
 * bundles, push to Cloudflare, and commit the bump — so every deployed build
 * is attributable to a commit and the version is visible in the panel header
 * of every surface. If the tree is dirty beyond the bump, the commit contains
 * only the version files; deploy-of-uncommitted-code still works but the
 * version commit marks exactly when it went out.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd: string) => execSync(cmd, { stdio: 'inherit' });
const out = (cmd: string) => execSync(cmd, { encoding: 'utf8' }).trim();

run('npm version patch --no-git-tag-version');
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

run('npm run site:build');
run('npx wrangler deploy');

execSync('git add package.json package-lock.json');
run(`git commit -m "release: v${version}" -m "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"`);
console.log(`\nDeployed v${version} (${out('git rev-parse --short HEAD')})`);
