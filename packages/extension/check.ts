import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mintId, readPageOutbound } from './src/bridge.js';
import { leftBehindByNavigation, mayReclaim, reclaimKeyFor } from './src/lifecycle.js';

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

// `resume` and `history` were declared in PageOutbound and handled in
// content.ts, but never validated — so the content script dropped them without
// a reply and the page's promise never settled. With the extension installed,
// navigator.agent.resume() hung forever on every load and session.history()
// could not hydrate a transcript at all. The type-level guard in bridge.ts
// stops a future member from going the same way; these prove the two that did.
assert.deepEqual(
  readPageOutbound({ t: 'resume', rid: 'r_test', request: { name: 'Inkwell', tools: [] } }),
  { t: 'resume', rid: 'r_test', request: { name: 'Inkwell', tools: [], alwaysAsk: [] } },
);
assert.deepEqual(
  readPageOutbound({ t: 'history', rid: 'r_test', ref: 's_test' }),
  { t: 'history', rid: 'r_test', ref: 's_test' },
);
// A reclaim re-declares the surface's tools, so it is as much an authority
// statement as the original connect and gets the same sanitizer.
assert.equal(readPageOutbound({ t: 'resume', rid: 'r_test' }), undefined);
assert.equal(readPageOutbound({ t: 'history', rid: 'r_test' }), undefined);

console.log('extension boundary check passed');

// --- session lifecycle -----------------------------------------------------
//
// One lifecycle for both surfaces, keyed by an identity built only from what
// the browser stamped on the connecting port. These assertions are the consent
// boundary: a reclaim that crossed an origin, or that keyed on a page-supplied
// string, would pass none of them.

const widgetOn = (origin: string, title: string, tabId: number | undefined, source: unknown) =>
  reclaimKeyFor({ from: 'widget', origin, name: title, tabId, toolSource: source });

// The widget's surface name is `document.title` and changes on nearly every
// navigation; the key must not move with it.
assert.equal(
  widgetOn('https://shop.example', 'Cart — 2 items', 7, 'page-dom'),
  widgetOn('https://shop.example', 'Checkout | Shop', 7, 'page-dom'),
);
// ...but it must move with the origin and with the tab.
assert.notEqual(
  widgetOn('https://shop.example', 'Cart', 7, 'page-dom'),
  widgetOn('https://evil.example', 'Cart', 7, 'page-dom'),
);
assert.notEqual(
  widgetOn('https://shop.example', 'Cart', 7, 'page-dom'),
  widgetOn('https://shop.example', 'Cart', 8, 'page-dom'),
);
// A grant harvested from a document's own WebMCP registrations belongs to that
// document: it must never be parked for the next one.
assert.equal(widgetOn('https://shop.example', 'Cart', 7, 'webmcp'), null);
assert.equal(widgetOn('https://shop.example', 'Cart', 7, undefined), null);
// No tab to key on, and origins no human could have consented to.
assert.equal(widgetOn('https://shop.example', 'Cart', undefined, 'page-dom'), null);
for (const origin of ['null', 'unknown://', 'https://shop.example/cart', 'chrome-extension://abc', '']) {
  assert.equal(widgetOn(origin, 'Cart', 7, 'page-dom'), null, `reclaimable on degraded origin ${origin}`);
  assert.equal(
    reclaimKeyFor({ from: 'page', origin, name: 'Inkwell', tabId: 7, toolSource: undefined }),
    null,
    `reclaimable on degraded origin ${origin}`,
  );
}
// Two page surfaces on one origin stay distinct.
const pageKey = (origin: string, name: string) =>
  reclaimKeyFor({ from: 'page', origin, name, tabId: 7, toolSource: undefined });
assert.notEqual(pageKey('https://inkwell.example', 'Editor'), pageKey('https://inkwell.example', 'Inbox'));
assert.equal(pageKey('https://inkwell.example', 'Editor'), pageKey('https://inkwell.example', 'Editor'));

const key = widgetOn('https://shop.example', 'Cart', 7, 'page-dom');
assert.ok(key);
const live = { reclaimKey: key, origin: 'https://shop.example', closed: false, expiresAt: 2_000 };
assert.equal(mayReclaim(live, { key, origin: 'https://shop.example', now: 1_000 }), true);
// The key already embeds the origin; the origin is still checked on its own,
// so a mismatched pair can never be reclaimed.
assert.equal(mayReclaim(live, { key, origin: 'https://evil.example', now: 1_000 }), false);
assert.equal(mayReclaim({ ...live, origin: 'https://evil.example' }, { key, origin: 'https://shop.example', now: 1_000 }), false);
assert.equal(mayReclaim(live, { key: null, origin: 'https://shop.example', now: 1_000 }), false);
assert.equal(mayReclaim({ ...live, reclaimKey: null }, { key, origin: 'https://shop.example', now: 1_000 }), false);
// Reclaim never revives a closed session nor extends a lapsed grant.
assert.equal(mayReclaim({ ...live, closed: true }, { key, origin: 'https://shop.example', now: 1_000 }), false);
assert.equal(mayReclaim(live, { key, origin: 'https://shop.example', now: 2_000 }), false);

// Leaving the origin detaches; staying on it does not. Only a top-level
// document may evict, and only top-level entries are evicted — a cross-origin
// subframe must not be able to detach the tab's session.
const top = (origin: string, tabId: number) => ({ origin, tabId, frameId: 0 });
assert.equal(leftBehindByNavigation(top('https://shop.example', 7), top('https://evil.example', 7)), true);
assert.equal(leftBehindByNavigation(top('https://shop.example', 7), top('https://shop.example', 7)), false);
assert.equal(leftBehindByNavigation(top('https://shop.example', 7), top('https://evil.example', 8)), false);
assert.equal(
  leftBehindByNavigation(top('https://shop.example', 7), { origin: 'https://ads.example', tabId: 7, frameId: 3 }),
  false,
);
assert.equal(
  leftBehindByNavigation({ origin: 'https://ads.example', tabId: 7, frameId: 3 }, top('https://shop.example', 7)),
  false,
);
assert.equal(
  leftBehindByNavigation(top('https://shop.example', 7), { origin: 'https://evil.example', tabId: undefined, frameId: 0 }),
  false,
);

console.log('extension session lifecycle check passed');

const rootPackage = JSON.parse(await readFile(join(here, '../../package.json'), 'utf8')) as { version: string };
const inpage = await readFile(join(here, 'dist/inpage.js'), 'utf8');
const content = await readFile(join(here, 'dist/content.js'), 'utf8');
const serviceWorker = await readFile(join(here, 'dist/sw.js'), 'utf8');
const overlay = await readFile(join(here, 'dist/overlay.js'), 'utf8');
const overlayHtml = await readFile(join(here, 'dist/overlay.html'), 'utf8');
const staticManifest = JSON.parse(await readFile(join(here, 'static/manifest.json'), 'utf8')) as {
  version: string;
  _build_note?: string;
  permissions?: string[];
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
assert.doesNotMatch(content, /createChatStore|ui-chat/, 'content script bundles the chat renderer');
assert.match(overlay, /createChatStore/, 'extension iframe does not bundle the shared chat store');
assert.match(overlay, /ui-chat/, 'extension iframe does not bundle the shared Chat components');
assert.match(overlayHtml, /overlay\.js/, 'extension iframe page does not load its renderer');
assert.ok(!staticManifest.permissions?.includes('notifications'), 'approval flow must not depend on OS notifications');
assert.doesNotMatch(serviceWorker, /chrome\.notifications/, 'service worker still contains the unreliable notification approval path');
assert.match(serviceWorker, /chrome\.windows\.create/, 'service worker does not open the extension-owned approval window');

console.log(`extension build stamp check passed (${rootPackage.version})`);
