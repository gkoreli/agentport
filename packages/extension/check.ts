import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_ANSWER_CHARS,
  MAX_FORM_FIELDS,
  MAX_FORM_LABEL_CHARS,
  MAX_FORM_OPTIONS,
  MAX_PLAN_STEPS,
  MAX_PLAN_STEP_CHARS,
} from '@agentport/protocol';

import {
  mintId,
  readPageOutbound,
  sanitizeFormFields,
  sanitizePlanSteps,
  type AnswerField,
  type PageOutbound,
} from './src/bridge.js';
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

// --- elicitation, at the boundary ------------------------------------------
//
// An elicitation answer is the one page-controlled channel that carries USER
// AUTHORITY into the agent's reasoning — which is why ADR-024 refuses it on
// tiers whose answer surface a site can draw, and why this tier may carry it:
// the extension's surface is one the site cannot draw or read. So this is the
// most sensitive member of PageOutbound, and its validator REFUSES rather than
// repairs. Every bound below is the wire's own, because a boundary that
// accepted what the daemon's decoder will reject is a boundary that lies.

const answer = (over: Record<string, unknown> = {}) => ({
  t: 'answer',
  ref: 's_test',
  askId: 'ask_1',
  values: [{ key: 'draft', value: 'The second' }],
  ...over,
});

assert.deepEqual(readPageOutbound(answer()), {
  t: 'answer',
  ref: 's_test',
  askId: 'ask_1',
  values: [{ key: 'draft', value: 'The second' }],
});
// Absent values is a SKIP — a real answer meaning "proceed without one".
assert.deepEqual(readPageOutbound({ t: 'answer', ref: 's_test', askId: 'ask_1' }), {
  t: 'answer',
  ref: 's_test',
  askId: 'ask_1',
});
// An empty text field is a legitimate answer: the wire is `str(0, …)`, so the
// local `str()` helper — which requires a non-empty string — must not be used
// for a value.
assert.deepEqual(readPageOutbound(answer({ values: [{ key: 'draft', value: '' }] })), {
  t: 'answer',
  ref: 's_test',
  askId: 'ask_1',
  values: [{ key: 'draft', value: '' }],
});
// Exactly at the wire's bounds, in both directions.
assert.equal(
  readPageOutbound(answer({ values: [{ key: 'draft', value: 'x'.repeat(MAX_ANSWER_CHARS) }] }))?.t,
  'answer',
);
assert.equal(
  readPageOutbound(
    answer({ values: Array.from({ length: MAX_FORM_FIELDS }, (_, i) => ({ key: `f${i}`, value: 'v' })) }),
  )?.t,
  'answer',
);

// Refused, never repaired. Dropping one bad field and forwarding the rest
// would deliver, under the user's own authority, an answer they did not give —
// and nothing downstream can un-attribute it afterwards.
for (const bad of [
  answer({ askId: 'not a valid id' }),
  answer({ askId: '' }),
  answer({ askId: 'a'.repeat(65) }),
  answer({ ref: undefined }),
  answer({ values: 'draft=The second' }),
  answer({ values: [{ key: 'draft' }] }),
  answer({ values: [{ key: 'draft', value: 42 }] }),
  answer({ values: [{ key: 'draft', value: null }] }),
  answer({ values: [{ key: 'not a key', value: 'x' }] }),
  answer({ values: [{ key: '', value: 'x' }] }),
  answer({ values: [{ key: 'draft', value: 'x'.repeat(MAX_ANSWER_CHARS + 1) }] }),
  answer({ values: [{ key: 'draft', value: 'a' }, { key: 'draft', value: 'b' }] }),
  answer({ values: Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => ({ key: `f${i}`, value: 'v' })) }),
  answer({ values: ['draft'] }),
  answer({ values: [null] }),
]) {
  assert.equal(
    readPageOutbound(bad),
    undefined,
    `an unusable answer was forwarded as the user's own: ${JSON.stringify(bad)}`,
  );
}
// Present-but-unusable must not collapse into a skip: the two look alike here
// and mean opposite things to the person the answer is attributed to.
assert.notDeepEqual(readPageOutbound(answer({ values: [{ key: 'draft', value: 42 }] })), {
  t: 'answer',
  ref: 's_test',
  askId: 'ask_1',
});

// Rebuilt onto fresh objects, like every other member. `__proto__` satisfies
// ID_PATTERN, so it is a legal field key and the rebuild is what keeps it
// harmless — and `Object.fromEntries` in the worker DEFINES the property
// rather than assigning it, so it never reaches the prototype setter.
const smuggledAnswer = JSON.parse('{"key":"draft","value":"ok","extra":1}') as unknown;
assert.deepEqual(
  Object.getOwnPropertyNames(
    (readPageOutbound(answer({ values: [smuggledAnswer] })) as { values: object[] }).values[0] ?? {},
  ),
  ['key', 'value'],
  'an answer field carried keys the schema does not name',
);
const materialised = Object.fromEntries(
  (readPageOutbound(answer({ values: [{ key: '__proto__', value: 'x' }] })) as { values: AnswerField[] }).values.map(
    (f) => [f.key, f.value],
  ),
);
assert.deepEqual(Object.getOwnPropertyNames(materialised), ['__proto__']);
assert.equal(Object.getPrototypeOf(materialised), Object.prototype, 'a form key reached the prototype setter');

// --- elicitation, the question side ----------------------------------------
//
// The mirror, on the way out. All-or-nothing for the same reason a plan
// snapshot is: half a form asks the user something the agent did not ask, and
// they would answer it with their own authority.

const field = (over: Record<string, unknown> = {}) => ({ key: 'draft', label: 'Draft', ...over });

assert.deepEqual(sanitizeFormFields([field()]), [{ key: 'draft', label: 'Draft' }]);
assert.deepEqual(sanitizeFormFields([field({ options: ['a', 'b'], multi: true })]), [
  { key: 'draft', label: 'Draft', options: ['a', 'b'], multi: true },
]);
assert.deepEqual(sanitizeFormFields([field({ options: ['a'] })]), [{ key: 'draft', label: 'Draft', options: ['a'] }]);
assert.deepEqual(
  Object.getOwnPropertyNames(sanitizeFormFields([field({ note: 'extra' })])?.[0] ?? {}),
  ['key', 'label'],
  'a rendered form field carried keys the schema does not name',
);
for (const bad of [
  field({ multi: true }), // multi without options: a text box taking several answers
  field({ multi: 'yes', options: ['a'] }),
  field({ options: [] }),
  field({ options: ['a', 'a'] }),
  field({ options: ['a', ''] }),
  field({ options: Array.from({ length: MAX_FORM_OPTIONS + 1 }, (_, i) => `o${i}`) }),
  field({ options: 'a,b' }),
  field({ label: '' }),
  field({ label: 42 }),
  field({ label: 'x'.repeat(MAX_FORM_LABEL_CHARS + 1) }),
  field({ key: 'not a key' }),
  field({ key: 42 }),
  'draft',
  null,
]) {
  assert.equal(sanitizeFormFields([field(), bad]), undefined, `a malformed field was rendered: ${JSON.stringify(bad)}`);
}
assert.equal(sanitizeFormFields([field(), field()]), undefined, 'two fields sharing one key were rendered');
assert.equal(sanitizeFormFields([]), undefined, 'a question with no fields is not a question');
assert.equal(sanitizeFormFields(Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => field({ key: `f${i}` }))), undefined);
assert.equal(sanitizeFormFields(Array.from({ length: MAX_FORM_FIELDS }, (_, i) => field({ key: `f${i}` })))?.length, MAX_FORM_FIELDS);
for (const notAForm of [undefined, null, 'draft', 42, {}, { fields: [] }]) {
  assert.equal(sanitizeFormFields(notAForm), undefined, `${JSON.stringify(notAForm)} was accepted as a form`);
}

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

// --- elicitation round trip, through the real page provider ----------------
//
// WHAT THIS COVERS, precisely, because the gap matters as much as the check.
// It drives the REAL `inpage.ts` in a DOM: the agent's question arrives as an
// event envelope and must surface as an `ask` on the page's session handle,
// and `session.answer()` must produce a message the REAL `readPageOutbound`
// accepts and rebuilds. Those are the two ends — the site's API and the
// trusted-side validator — and between them the envelope, channel and session
// routing are the provider's own code, not a stand-in.
//
// WHAT IT DOES NOT COVER: the two middle hops. `content.ts`'s ownership check
// (a page may only answer for a session THIS document owns) and `sw.ts`'s
// `lookup` both need a real `chrome.runtime`, and faking one would be a check
// of the fake. Those are exercised by `scripts/extension-ui-smoke.ts`, which
// loads the unpacked extension in Chrome. Stated rather than papered over: a
// regression in either hop would not fail this file.

const { Window } = await import('happy-dom');
const { ENVELOPE, TO_PAGE, TO_WALLET } = await import('./src/bridge.js');

const win = new Window({ url: 'https://elicit.test/' });
const globals = globalThis as Record<string, unknown>;
for (const key of ['window', 'document', 'navigator', 'MessageEvent', 'CustomEvent', 'Event']) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
// esbuild substitutes this at build time; the source reads it as a global.
globals['__AGENTPORT_VERSION__'] = rootPackage.version;

const CHANNEL = 'ch_check';
const injected = win.document.createElement('script');
injected.dataset['channel'] = CHANNEL;
win.document.head.appendChild(injected);
// The provider reads its channel off the injecting <script> exactly as it does
// in a real document; `currentScript` is null during a dynamic import.
Object.defineProperty(win.document, 'currentScript', { value: injected, configurable: true });

/** Everything the page posted, as the CONTENT SCRIPT would see it: validated. */
const validated: PageOutbound[] = [];
/** …and everything it posted at all, so a refusal is distinguishable from silence. */
const posted: unknown[] = [];
win.addEventListener('message', (event: unknown) => {
  const data = (event as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return;
  const envelope = data as Record<string, unknown>;
  if (envelope['e'] !== ENVELOPE || envelope['dir'] !== TO_WALLET || envelope['channel'] !== CHANNEL) return;
  posted.push(envelope['body']);
  const body = readPageOutbound(envelope['body']);
  if (body) validated.push(body);
});

const toPage = (body: unknown): void => {
  win.postMessage({ e: ENVELOPE, dir: TO_PAGE, channel: CHANNEL, body }, 'https://elicit.test');
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

await import('./src/inpage.js');
await settle();

interface CheckSession {
  id: string;
  on(event: 'ask', listener: (value: { id: string; message: string; fields: unknown[] }) => void): () => void;
  answer(askId: string, values?: Record<string, string>): void;
}
const agent = (win.navigator as unknown as { agent: { connect(request: unknown): Promise<CheckSession> } }).agent;

const connecting = agent.connect({ name: 'Elicit', tools: [] });
await settle();
const connectRequest = validated.find((message) => message.t === 'connect');
assert.ok(connectRequest && 'rid' in connectRequest, 'the provider never asked to connect');
toPage({
  t: 'ok',
  rid: connectRequest.rid,
  value: {
    ref: 's_check',
    info: { agentName: 'Personal agent', runtime: 'agent', ownTools: true },
    grant: { tools: [], alwaysAsk: [], expiresAt: Date.now() + 60_000 },
  },
});
const pageSession = await connecting;
assert.equal(pageSession.id, 's_check');

// 1. The question reaches the site.
const questions: { id: string; message: string; fields: unknown[] }[] = [];
pageSession.on('ask', (value) => questions.push(value));
toPage({
  t: 'event',
  ref: 's_check',
  event: 'ask',
  payload: {
    id: 'ask_1',
    message: 'Which draft should I revise?',
    fields: [{ key: 'draft', label: 'Draft', options: ['The first', 'The second'], multi: false }],
  },
});
await settle();
assert.equal(questions.length, 1, 'the agent asked and the page was never told');
assert.deepEqual(questions[0], {
  id: 'ask_1',
  message: 'Which draft should I revise?',
  fields: [{ key: 'draft', label: 'Draft', options: ['The first', 'The second'], multi: false }],
});

// A question that does not rebuild is dropped whole rather than half-drawn:
// the user must never answer something the agent did not ask.
toPage({
  t: 'event',
  ref: 's_check',
  event: 'ask',
  payload: { id: 'ask_2', message: 'Pick one', fields: [{ key: 'draft', label: 'Draft', multi: true }] },
});
await settle();
assert.equal(questions.length, 1, 'a malformed question was shown to the user anyway');

// 2. The answer comes back, and survives the trusted side's validator.
validated.length = 0;
posted.length = 0;
pageSession.answer('ask_1', { draft: 'The second' });
await settle();
assert.deepEqual(
  validated,
  [{ t: 'answer', ref: 's_check', askId: 'ask_1', values: [{ key: 'draft', value: 'The second' }] }],
  'the answer did not survive the page boundary',
);

// 3. A skip is a real answer, and travels as one.
validated.length = 0;
pageSession.answer('ask_1');
await settle();
assert.deepEqual(validated, [{ t: 'answer', ref: 's_check', askId: 'ask_1' }]);

// 4. An answer the wire could not carry fails HERE, in the caller's own stack,
//    rather than crossing three hops to be dropped by a validator that has no
//    way to reply — which the caller would experience as the agent's question
//    timing out minutes later.
validated.length = 0;
posted.length = 0;
assert.throws(
  () => pageSession.answer('ask_1', { draft: 'x'.repeat(MAX_ANSWER_CHARS + 1) }),
  /exceeds the protocol limit/,
);
assert.throws(() => pageSession.answer('not a valid id', { draft: 'ok' }), /invalid ask id/);
assert.equal(posted.length, 0, 'an unusable answer was put on the wire anyway');

console.log('extension elicitation round-trip check passed');
