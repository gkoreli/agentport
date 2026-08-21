/**
 * Two things every check in this repo needs and neither of them twice.
 *
 * `deadline` exists because a check that hangs is not a check: a hang is
 * indistinguishable from slowness and nobody waits to find out.
 *
 * `buildSite` exists because the artifact a check inspects must be the artifact
 * a deploy publishes. Both `snippet:check` and `deployed:check` need a fresh
 * `site/public/connect.js`, and the wrong way to get one is a second esbuild
 * invocation with its own copy of the options — that is how a harness ends up
 * proving something about a file nobody ships. `site/build.ts` is the one
 * builder, it carries the classic-script guard, and `scripts/deploy.ts` runs
 * the same thing.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${what} (deadline ${ms}ms)`)), ms);
      timer.unref?.();
    }),
  ]);
}

const BUILD_DEADLINE_MS = 90_000;

/**
 * Build the browser artifacts exactly as `npm run site:build` does.
 *
 * `env` overrides are for `AGENTPORT_BUILD_VERSION`, which CI stamps into the
 * bundles; a caller that compares bytes against a deployment needs to know
 * whether that stamp is inside the file it is comparing.
 */
export async function buildSite(env: Record<string, string> = {}): Promise<void> {
  await deadline(
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [join(repoRoot, 'node_modules/tsx/dist/cli.mjs'), join(repoRoot, 'site/build.ts')],
        { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } },
      );
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.stderr.on('data', (chunk) => (output += String(chunk)));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`site/build.ts exited ${code}\n${output}`)),
      );
    }),
    BUILD_DEADLINE_MS,
    'the site build never finished',
  );
}
