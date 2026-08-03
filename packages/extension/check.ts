import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mintId, readPageOutbound } from './src/bridge.js';

const here = dirname(fileURLToPath(import.meta.url));

const promptId = mintId('p_');
assert.match(promptId, /^p_[0-9a-f]{24}$/);
assert.deepEqual(
  readPageOutbound({ t: 'prompt', rid: 'r_test', ref: 's_test', promptId, text: 'hello' }),
  { t: 'prompt', rid: 'r_test', ref: 's_test', promptId, text: 'hello' },
);
assert.equal(
  readPageOutbound({ t: 'prompt', rid: 'r_test', ref: 's_test', promptId: 'predictable', text: 'hello' }),
  undefined,
);
assert.equal(readPageOutbound({ t: 'prompt.cancel', ref: 's_test', promptId: 'predictable' }), undefined);

console.log('extension boundary check passed');

const rootPackage = JSON.parse(await readFile(join(here, '../../package.json'), 'utf8')) as { version: string };
const inpage = await readFile(join(here, 'dist/inpage.js'), 'utf8');
const staticManifest = JSON.parse(await readFile(join(here, 'static/manifest.json'), 'utf8')) as {
  version: string;
  _build_note?: string;
};
const distManifestText = await readFile(join(here, 'dist/manifest.json'), 'utf8');
const distManifest = JSON.parse(distManifestText) as { version: string; _build_note?: string };

assert.ok(inpage.includes(rootPackage.version), 'dist/inpage.js does not contain the root version stamp');
assert.doesNotMatch(inpage, /["']dev["']/, 'dist/inpage.js contains the development version sentinel');
assert.notEqual(staticManifest.version, rootPackage.version, 'static manifest must retain a non-release placeholder');
assert.equal(distManifest.version, rootPackage.version, 'dist manifest does not match the root version');
assert.equal(distManifest._build_note, undefined, 'static manifest placeholder note shipped to dist');
assert.ok(
  !distManifestText.includes(staticManifest.version),
  `static manifest placeholder ${staticManifest.version} shipped to dist`,
);

console.log(`extension build stamp check passed (${rootPackage.version})`);
