import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_PLAN_STEPS, MAX_PLAN_STEP_CHARS } from '@agentport/protocol';

import { mintId, readPageOutbound, sanitizePlanSteps } from './src/bridge.js';
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

// --- plan snapshots --------------------------------------------------------
//
// A plan crosses two hops after the wire (worker → content script → the
// extension-origin iframe that draws it), and one validator serves both. What
// these assert is the rule that makes a plan a plan: it is a SNAPSHOT of what
// the agent intends now, so it is renderable whole or not at all. Half a
// checklist is a claim about the agent's intentions that the agent never made.

const step = (over: Record<string, unknown> = {}) => ({ text: 'Read the draft', status: 'pending', ...over });

assert.deepEqual(sanitizePlanSteps([]), [], 'an empty snapshot is how a finished turn clears its plan');
assert.deepEqual(
  sanitizePlanSteps([step(), step({ status: 'active', priority: 'high' }), step({ status: 'done' })]),
  [
    { text: 'Read the draft', status: 'pending' },
    { text: 'Read the draft', status: 'active', priority: 'high' },
    { text: 'Read the draft', status: 'done' },
  ],
);
// Rebuilt, not narrowed: anything the sender attached that the schema does not
// name must not ride along into the renderer — including an own `__proto__`,
// which only a rebuild onto a fresh object makes structurally harmless.
assert.deepEqual(sanitizePlanSteps([step({ note: 'extra' })]), [{ text: 'Read the draft', status: 'pending' }]);
const smuggled = JSON.parse('{"text":"Read the draft","status":"pending","__proto__":{"x":1}}') as unknown;
assert.deepEqual(
  Object.getOwnPropertyNames(sanitizePlanSteps([smuggled])?.[0] ?? {}),
  ['text', 'status'],
  'a rendered plan step carried keys the schema does not name',
);

// One bad step refuses the whole snapshot — the renderer keeps the last good
// plan rather than showing a checklist with a step missing from the middle.
for (const bad of [
  step({ status: 'in_progress' }),
  step({ status: 'PENDING' }),
  step({ status: undefined }),
  step({ status: 1 }),
  step({ text: '' }),
  step({ text: 42 }),
  step({ text: undefined }),
  step({ text: 'x'.repeat(MAX_PLAN_STEP_CHARS + 1) }),
  step({ priority: 'urgent' }),
  step({ priority: null }),
  'Read the draft',
  null,
  [],
]) {
  assert.equal(
    sanitizePlanSteps([step(), bad, step({ status: 'done' })]),
    undefined,
    `a snapshot containing ${JSON.stringify(bad)} was rendered anyway`,
  );
}
// Priority is optional, and absent is not the same as present-and-invalid.
assert.deepEqual(sanitizePlanSteps([step({ priority: undefined })]), [{ text: 'Read the draft', status: 'pending' }]);
assert.deepEqual(sanitizePlanSteps([step({ priority: 'low' })]), [
  { text: 'Read the draft', status: 'pending', priority: 'low' },
]);

// The wire cap is the renderer's cap: a snapshot that crossed the sealed
// channel intact is never refused here for its size, and one that could not
// have come off the wire is never drawn.
assert.equal(sanitizePlanSteps(Array.from({ length: MAX_PLAN_STEPS }, () => step()))?.length, MAX_PLAN_STEPS);
assert.equal(sanitizePlanSteps(Array.from({ length: MAX_PLAN_STEPS + 1 }, () => step())), undefined);
assert.deepEqual(sanitizePlanSteps([step({ text: 'x'.repeat(MAX_PLAN_STEP_CHARS) })]), [
  { text: 'x'.repeat(MAX_PLAN_STEP_CHARS), status: 'pending' },
]);

// Not an array is not "no plan": there is no snapshot here at all, and the
// caller must say so rather than silently clear a plan the agent still holds.
for (const notAPlan of [undefined, null, 'plan', 42, {}, { steps: [] }]) {
  assert.equal(sanitizePlanSteps(notAPlan), undefined, `${JSON.stringify(notAPlan)} was accepted as a plan`);
}
// A sparse array has holes the item loop would otherwise read as undefined.
const sparse: unknown[] = [step()];
sparse.length = 3;
assert.equal(sanitizePlanSteps(sparse), undefined, 'a sparse plan array was accepted');

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
// The plan checklist and the sealing-key fingerprint words are drawn in the
// extension's own frame, never in the page's world — the same boundary the
// chat renderer is held to, and a stronger requirement for the fingerprint
// words, which exist to be trusted.
// Matched on the rendered markup, not on the class name: the stylesheet in
// this same bundle mentions `.plan-step` whether or not anything draws one.
assert.match(overlay, /class="plan-step"/, 'extension iframe does not render the agent plan');
assert.match(overlay, /class="verify"/, 'extension iframe does not render the attachment fingerprint words');
assert.doesNotMatch(content, /class="plan-step"|class="verify"/, 'content script draws attachment state into the page');
assert.match(overlayHtml, /overlay\.js/, 'extension iframe page does not load its renderer');
assert.ok(!staticManifest.permissions?.includes('notifications'), 'approval flow must not depend on OS notifications');
assert.doesNotMatch(serviceWorker, /chrome\.notifications/, 'service worker still contains the unreliable notification approval path');
assert.match(serviceWorker, /chrome\.windows\.create/, 'service worker does not open the extension-owned approval window');

console.log(`extension build stamp check passed (${rootPackage.version})`);
