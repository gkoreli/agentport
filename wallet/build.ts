import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, 'public');
const { version } = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string };

mkdirSync(publicDir, { recursive: true });
// Workers static-asset SPA fallback serves index.html for /connect.
copyFileSync(join(here, 'wallet.html'), join(publicDir, 'index.html'));

await esbuild.build({
  entryPoints: [join(here, 'src/app.ts')],
  outfile: join(publicDir, 'wallet.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
  define: { __AGENTPORT_VERSION__: JSON.stringify(version) },
});
