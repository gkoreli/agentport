import * as esbuild from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, 'src/inkwell.ts'), join(here, 'src/tasker.ts')],
  outdir: join(here, 'public'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  logLevel: 'info',
});
