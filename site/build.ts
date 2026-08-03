import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as { version: string };

await esbuild.build({
  entryPoints: [join(here, 'src/connect.ts'), join(here, 'src/inkwell.ts'), join(here, 'src/tasker.ts')],
  outdir: join(here, 'public'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
  define: { __AGENTPORT_VERSION__: JSON.stringify(version) },
});
