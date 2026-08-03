/**
 * Four bundles, three execution contexts, deliberately separate outputs.
 *
 *   sw.js       — MV3 service worker. Holds the key and the socket, so nothing
 *                 that runs in a page may ever share a module graph with it.
 *   content.js  — isolated world. Classic script (content scripts are not
 *                 modules), injects and bridges the extension-origin iframe.
 *   overlay.js  — extension-origin iframe; owns the Nisli Chat registry.
 *   inpage.js   — page world. The only bundle a site can touch; kept free of
 *                 protocol crypto so nothing key-shaped is ever parsed there.
 *   popup.js    — extension origin.
 *   consent.js  — extension origin; the consent/approval window (ADR-009).
 */

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, 'dist');
const watch = process.argv.includes('--watch');
const rootPackage = JSON.parse(await readFile(join(here, '../../package.json'), 'utf8')) as { version?: unknown };
const version = rootPackage.version;

if (typeof version !== 'string' || !/^\d+(\.\d+){0,3}$/.test(version)) {
  throw new Error(`root package version is not a Chrome extension version: ${String(version)}`);
}

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

const shared = {
  bundle: true,
  target: 'es2022',
  sourcemap: 'inline',
  logLevel: 'info',
  legalComments: 'none',
  define: { __AGENTPORT_VERSION__: JSON.stringify(version) },
} as const satisfies Partial<esbuild.BuildOptions>;

const builds: esbuild.BuildOptions[] = [
  { ...shared, entryPoints: [join(here, 'src/sw.ts')], outfile: join(outdir, 'sw.js'), format: 'esm' },
  { ...shared, entryPoints: [join(here, 'src/content.ts')], outfile: join(outdir, 'content.js'), format: 'iife' },
  { ...shared, entryPoints: [join(here, 'src/overlay.ts')], outfile: join(outdir, 'overlay.js'), format: 'iife' },
  { ...shared, entryPoints: [join(here, 'src/inpage.ts')], outfile: join(outdir, 'inpage.js'), format: 'iife' },
  { ...shared, entryPoints: [join(here, 'src/popup.ts')], outfile: join(outdir, 'popup.js'), format: 'iife' },
  { ...shared, entryPoints: [join(here, 'src/consent.ts')], outfile: join(outdir, 'consent.js'), format: 'iife' },
];

async function copyStatic(): Promise<void> {
  await cp(join(here, 'static'), outdir, { recursive: true });
  const source = JSON.parse(await readFile(join(here, 'static/manifest.json'), 'utf8')) as Record<string, unknown>;
  delete source['_build_note'];
  source['version'] = version;
  await writeFile(join(outdir, 'manifest.json'), `${JSON.stringify(source, null, 2)}\n`);
}

if (watch) {
  for (const options of builds) {
    const context = await esbuild.context(options);
    await context.watch();
  }
  await copyStatic();
  console.log(`[agentport] watching → ${outdir}`);
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  await copyStatic();
  console.log(`[agentport] extension built → ${outdir}`);
}
