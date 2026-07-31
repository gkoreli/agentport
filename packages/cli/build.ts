/**
 * Bundle the CLI into one self-contained file so the published package has
 * zero dependencies — `npx @agentport/cli` downloads one tarball and runs.
 * Workspace packages and node deps (ws, @noble, the ACP sdk) are all inlined;
 * only ws's optional native accelerators stay external, exactly as ws itself
 * treats them.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      // ws is CommonJS; give the ESM bundle a working require for it.
      "import { createRequire as __cr } from 'node:module';",
      'const require = __cr(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
});
