import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = join(here, '..', 'public');
const port = Number(process.env.PORT ?? 8788);

await esbuild.build({
  entryPoints: [join(here, 'app.ts')],
  outfile: join(publicDir, 'bundle.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  sourcemap: 'inline',
  logLevel: 'info',
});

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const path = (req.url ?? '/').split('?')[0]!;
  // /pair is the link the daemon prints; it renders the same page.
  const file = path === '/' || path === '/pair' ? 'index.html' : path.replace(/^\//, '');
  try {
    const body = await readFile(join(publicDir, file));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => {
  console.log(`[inkwell] http://127.0.0.1:${port}`);
});
