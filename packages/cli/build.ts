/**
 * Bundle the CLI into one self-contained file so the published package has
 * zero dependencies — `npx @gkoreli/agentport` downloads one tarball and runs.
 * Workspace packages and node deps (ws, @noble, the ACP sdk) are all inlined;
 * only ws's optional native accelerators stay external, exactly as ws itself
 * treats them.
 */
import { build, type BuildOptions } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

const shared: BuildOptions = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  define: { __AGENTPORT_CLI_VERSION__: JSON.stringify(version) },
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
};

await build({
  ...shared,
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
});

// This is release evidence, not a second smoke implementation: the repository
// command imports the same source, while CI runs this copy from the exact
// tarball it verified and will publish.
export async function buildRemoteCheck(): Promise<void> {
  await build({
    ...shared,
    entryPoints: ['src/remote-check.ts'],
    outfile: 'dist/remote-check.js',
  });
}

await buildRemoteCheck();
