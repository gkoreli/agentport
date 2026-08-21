/**
 * WebMCP conformance check — `npm run webmcp:harvest`.
 *
 * Two things are being defended here, and they fail differently.
 *
 * 1. **The gating rule.** A harvested tool always asks. The bug this replaces
 *    gated only on `annotations.destructiveHint === true`, so a page that
 *    omitted the field got an ungated write — *missing* metadata granted
 *    authority. Every gating case below is written so that reverting
 *    `toSiteTool` in packages/client/src/webmcp.ts turns it red, and red with a
 *    message about gating rather than about something else.
 *
 * 2. **Our belief about someone else's draft.** `packages/client/src/webmcp.ts`
 *    is that belief. These cases pin the parts of it that are behaviour: the
 *    promise-gated adoption, verbatim option forwarding, signal-driven
 *    withdrawal, the shape of the shim, and the members the draft no longer
 *    has. They are keyed on the exported `WEBMCP` constant wherever they can
 *    be, so a member sneaking back into the shim is caught by name.
 *
 * What this check cannot prove is that our belief matches the draft. Nothing
 * can — see the header of packages/client/src/webmcp.ts. It proves the code
 * matches the belief, in one place, which is the part that is checkable.
 */

import type { Logger, LogContext, LogLevel } from '@agentport/protocol';
import {
  WEBMCP,
  WEBMCP_NOT_IMPLEMENTED,
  createWebMcpRegistry,
  normalizeToolResult,
  readRegistration,
  type ModelContextLike,
} from '../packages/client/src/webmcp.js';
import type { SiteTool } from '../packages/client/src/index.js';
import { createWebMcpHarvester } from '../site/src/webmcp.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
}

interface Line {
  level: LogLevel;
  message: string;
  data: Record<string, unknown> | undefined;
}

/**
 * Hand-rolled rather than `createLogger({ sink })`: a level filter between the
 * code and the assertion is one more way for a check to go quiet without
 * anybody noticing.
 */
function recorder(): { logger: Logger; lines: Line[] } {
  const lines: Line[] = [];
  const at = (level: LogLevel) => (message: string, context?: LogContext) => {
    lines.push({ level, message, data: context?.data });
  };
  const logger: Logger = {
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    child: () => logger,
  };
  return { logger, lines };
}

/** Rule 3: nothing here may hang. Every await gets a deadline. */
function deadline<T>(promise: PromiseLike<T>, label: string, ms = 2_000): Promise<T> {
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} did not settle in ${ms}ms`)), ms)),
  ]);
}

function settled(): Promise<void> {
  // Adoption hangs off the registration promise, so state is one microtask
  // behind the call. Two turns is enough for `then(then(...))`.
  return new Promise((resolve) => setImmediate(resolve));
}

const tool = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'doc.read',
  description: 'Read the document',
  inputSchema: { type: 'object', properties: {} },
  execute: () => ({ text: 'hello' }),
  ...over,
});

// ---------------------------------------------------------------------------
console.log('1. the gating rule: a harvested tool always asks');
// ---------------------------------------------------------------------------
//
// The site tier and the widget tier both reach the grant through this mapping,
// so proving it here proves it for both. `requiresApproval` is what the daemon
// (daemon.ts) and the wallet (client/session.ts) read to force the approval
// round-trip, and what the extension consent window lists under "Asks every
// time".

{
  const registry = createWebMcpRegistry();
  const context: ModelContextLike = { registerTool: () => Promise.resolve(undefined) };
  registry.observe(context);

  // Distinct names on purpose: one registry entry per case, so a case that
  // stops being gated is named in the output instead of being overwritten by
  // the next one. (The first version of this check reused one name and three
  // of the seven cases silently replaced each other.)
  const cases: Array<[string, Record<string, unknown>]> = [
    ['no.annotations', {}],
    ['empty.annotations', { annotations: {} }],
    ['read.only.hint', { annotations: { readOnlyHint: true } }],
    ['destructive.false', { annotations: { destructiveHint: false } }],
    ['destructive.true', { annotations: { destructiveHint: true } }],
    ['account.delete', {}],
    ['doc.get', {}],
  ];

  for (const [name, over] of cases) void context.registerTool?.(tool({ name, ...over }));
  await deadline(settled(), 'gating registrations');

  const harvested = registry.tools();
  check('every case was harvested', harvested.length === cases.length, harvested.map((t) => t.name));
  for (const harvestedTool of harvested) {
    check(
      `gated: ${harvestedTool.name}`,
      harvestedTool.requiresApproval === true,
      { tool: harvestedTool.name, requiresApproval: harvestedTool.requiresApproval },
    );
  }
  // Stated as a set so a future tool that slips through is named, not averaged
  // away by the ones that pass.
  const ungated = harvested.filter((t) => t.requiresApproval !== true).map((t) => t.name);
  check('no harvested tool reached the grant ungated', ungated.length === 0, { ungated });
}

// ---------------------------------------------------------------------------
console.log('\n2. page-authored metadata reaches nothing that decides');
// ---------------------------------------------------------------------------
{
  const read = readRegistration(tool({ annotations: { readOnlyHint: true, untrustedContentHint: true } }));
  check('annotations survive the read (they are evidence, not authority)', read.ok && read.value.annotations.readOnlyHint === true, read);
  check('untrustedContentHint survives the read', read.ok && read.value.annotations.untrustedContentHint === true, read);
  // The one field the old rule consulted is not even part of the current
  // draft's annotation set, which is why taking it as authority was doubly
  // wrong: an MCP field, from an untrusted party, deciding an AgentPort gate.
  check(
    'destructiveHint is not in the draft annotation set we record',
    !(WEBMCP.annotations as readonly string[]).includes('destructiveHint'),
    WEBMCP.annotations,
  );
}

// ---------------------------------------------------------------------------
console.log('\n3. descriptors are refused, not repaired');
// ---------------------------------------------------------------------------
{
  const refusals: Array<[string, unknown, string]> = [
    ['not an object', 'doc.read', 'not_an_object'],
    ['no name', tool({ name: undefined }), 'invalid_name'],
    ['name with a space', tool({ name: 'doc read' }), 'invalid_name'],
    ['name over 128 chars', tool({ name: 'a'.repeat(129) }), 'invalid_name'],
    ['no description', tool({ description: undefined }), 'missing_description'],
    ['empty description', tool({ description: '' }), 'missing_description'],
    ['inputSchema is an array', tool({ inputSchema: [] }), 'invalid_schema'],
    ['inputSchema is a string', tool({ inputSchema: 'object' }), 'invalid_schema'],
    ['no execute', tool({ execute: undefined }), 'missing_execute'],
  ];
  for (const [label, value, reason] of refusals) {
    const read = readRegistration(value);
    check(`refused (${reason}): ${label}`, !read.ok && read.reason === reason, read);
  }
  // A cyclic schema is JSON-unserializable, which the draft says rejects.
  const cyclic: Record<string, unknown> = { type: 'object' };
  cyclic['self'] = cyclic;
  const cyclicRead = readRegistration(tool({ inputSchema: cyclic }));
  check('refused (invalid_schema): cyclic inputSchema', !cyclicRead.ok && cyclicRead.reason === 'invalid_schema', cyclicRead);

  // Omitted is not invalid: `inputSchema` is genuinely optional in the draft.
  const omitted = readRegistration(tool({ inputSchema: undefined }));
  check('an omitted inputSchema defaults to {type:"object"}', omitted.ok && omitted.value.inputSchema['type'] === 'object', omitted);
  const titled = readRegistration(tool({ title: 'Read it' }));
  check('title is read (2026-04-09 addition)', titled.ok && titled.value.title === 'Read it', titled);
}

// ---------------------------------------------------------------------------
console.log('\n4. the native implementation is the authority on acceptance');
// ---------------------------------------------------------------------------
{
  const { logger, lines } = recorder();
  const registry = createWebMcpRegistry({ logger });
  let resolveRegistration: (() => void) | undefined;
  const context: ModelContextLike = {
    registerTool: () => new Promise<undefined>((resolve) => { resolveRegistration = () => resolve(undefined); }),
  };
  registry.observe(context);

  void context.registerTool?.(tool({ name: 'doc.slow' }));
  await deadline(settled(), 'pending registration');
  check('not adopted while the registration promise is pending', registry.size() === 0, registry.tools());
  resolveRegistration?.();
  await deadline(settled(), 'fulfilled registration');
  check('adopted once the implementation fulfils', registry.size() === 1, registry.tools().map((t) => t.name));

  // A rejected registration is a tool the browser refused. Lending it would
  // show the agent a capability no conforming WebMCP consumer can see.
  const rejecting: ModelContextLike = { registerTool: () => Promise.reject(new Error('duplicate name')) };
  const rejected = createWebMcpRegistry({ logger });
  rejected.observe(rejecting);
  void (rejecting.registerTool?.(tool({ name: 'doc.refused' })) as Promise<unknown>).catch(() => {});
  await deadline(settled(), 'rejected registration');
  check('a rejected registration is never adopted', rejected.size() === 0, rejected.tools());
  check(
    'the rejection is logged, not swallowed',
    lines.some((line) => line.message.includes('rejected by the implementation')),
    lines.map((line) => line.message),
  );
}

// ---------------------------------------------------------------------------
console.log('\n5. registration options are forwarded verbatim');
// ---------------------------------------------------------------------------
//
// Both harvesters used to call `registerTool.call(this, tool)`, dropping the
// options object. That silently disabled the page's own unregistration and its
// cross-origin exposure declaration in the NATIVE registry — a wrapper
// changing the behaviour of the thing it wrapped.
{
  const registry = createWebMcpRegistry();
  const seen: unknown[][] = [];
  const context: ModelContextLike = {
    registerTool: (...args: unknown[]) => {
      seen.push(args);
      return Promise.resolve(undefined);
    },
  };
  registry.observe(context);

  const controller = new AbortController();
  const options = { signal: controller.signal, exposedTo: ['https://frame.example'] };
  void context.registerTool?.(tool({ name: 'doc.signalled' }), options);
  await deadline(settled(), 'options registration');

  check('the native implementation received both arguments', seen[0]?.length === 2, seen[0]?.length);
  check('the options object arrived by identity, not a copy', seen[0]?.[1] === options, seen[0]?.[1]);
  check('adopted with the signal bound', registry.size() === 1, registry.tools().map((t) => t.name));

  controller.abort();
  await deadline(settled(), 'abort');
  check('aborting the registration signal withdraws the tool', registry.size() === 0, registry.tools().map((t) => t.name));

  // An already-aborted signal must not register at all: the page retracted the
  // tool before we finished adopting it.
  const dead = AbortSignal.abort();
  void context.registerTool?.(tool({ name: 'doc.stillborn' }), { signal: dead });
  await deadline(settled(), 'pre-aborted registration');
  check('an already-aborted signal leaves nothing behind', registry.size() === 0, registry.tools().map((t) => t.name));
}

// ---------------------------------------------------------------------------
console.log('\n6. tools registered before we arrived are reported, not invented');
// ---------------------------------------------------------------------------
//
// We monkey-patch, so a registration made before our script ran was never seen
// and its `execute` was never captured. `getTools()` tells us they exist —
// `RegisteredTool` carries no callback, so we cannot lend them, and the
// honest outcome is a warning naming them rather than a silent gap.
{
  const { logger, lines } = recorder();
  const registry = createWebMcpRegistry({ logger });
  const context: ModelContextLike = {
    registerTool: () => Promise.resolve(undefined),
    getTools: () => [
      { name: 'early.one', description: 'Registered before us', inputSchema: '{}', origin: 'https://site.example' },
      { name: 'early.two', description: 'Also early', inputSchema: '{}', origin: 'https://site.example' },
    ],
  };
  registry.observe(context);
  await deadline(settled(), 'getTools probe');

  check('pre-existing tools are not lent', registry.size() === 0, registry.tools());
  const warning = lines.find((line) => line.message.includes('registered before AgentPort loaded'));
  check('pre-existing tools are named in a warning', warning !== undefined, lines.map((line) => line.message));
  check(
    'the warning names both of them',
    JSON.stringify(warning?.data?.['tools']) === JSON.stringify(['early.one', 'early.two']),
    warning?.data,
  );
}

// ---------------------------------------------------------------------------
console.log('\n7. the shim is shaped like the current draft');
// ---------------------------------------------------------------------------
{
  const registry = createWebMcpRegistry();
  const shim = registry.shim('https://site.example') as ModelContextLike & Record<string, unknown>;

  // Keyed on the exported constant, so putting one of these back on the shim
  // fails by name instead of quietly reviving a 2026-03-05 removal.
  for (const member of WEBMCP.absent) {
    check(`the shim does not offer ${member}()`, shim[member] === undefined, typeof shim[member]);
  }
  check('the shim is an EventTarget', shim instanceof EventTarget, Object.getPrototypeOf(shim)?.constructor?.name);

  const changes: string[] = [];
  (shim as unknown as EventTarget).addEventListener('toolchange', () => changes.push('toolchange'));

  const registered = shim.registerTool?.(tool({ name: 'doc.read' }));
  check('registerTool() returns a promise', typeof (registered as PromiseLike<unknown>)?.then === 'function', typeof registered);
  const value = await deadline(registered as PromiseLike<unknown>, 'shim registerTool');
  check('registerTool() resolves undefined', value === undefined, value);
  check('registering fired toolchange', changes.length === 1, changes);

  // The draft's registration algorithm rejects; it does not silently replace.
  for (const [label, descriptor] of [
    ['a duplicate name', tool({ name: 'doc.read' })],
    ['an invalid name', tool({ name: 'doc read' })],
    ['an empty description', tool({ description: '' })],
    ['a missing execute', tool({ name: 'doc.other', execute: undefined })],
  ] as Array<[string, unknown]>) {
    let rejected = false;
    await deadline(
      Promise.resolve(shim.registerTool?.(descriptor)).then(() => {}, () => { rejected = true; }),
      `shim rejects ${label}`,
    );
    check(`registerTool() rejects ${label}`, rejected, label);
  }
  check('a rejected registration did not enter the registry', registry.size() === 1, registry.tools().map((t) => t.name));

  await deadline(Promise.resolve(shim.registerTool?.(tool({ name: 'aaa.first', description: 'First' }))), 'second tool');
  const listed = shim.getTools?.() as Array<Record<string, unknown>>;
  check('getTools() is sorted by name', listed?.map((t) => t['name']).join(',') === 'aaa.first,doc.read', listed?.map((t) => t['name']));
  check('getTools() stringifies inputSchema', typeof listed?.[0]?.['inputSchema'] === 'string', listed?.[0]?.['inputSchema']);
  check('getTools() reports the owning origin', listed?.[0]?.['origin'] === 'https://site.example', listed?.[0]?.['origin']);

  // Withdrawal is a tool change too. A site that listens for additions and
  // never hears the matching removal is worse off than one told nothing.
  const controller = new AbortController();
  await deadline(
    Promise.resolve(shim.registerTool?.(tool({ name: 'doc.temp' }), { signal: controller.signal })),
    'signalled shim registration',
  );
  const before = changes.length;
  controller.abort();
  await deadline(settled(), 'shim abort');
  check('withdrawal fires toolchange', changes.length === before + 1, { before, after: changes.length });
  check('withdrawal removes it from getTools()', !(shim.getTools?.() as Array<Record<string, unknown>>).some((t) => t['name'] === 'doc.temp'));

  // And the tools the shim hands us are gated like any other harvested tool:
  // the shim is a stand-in for a page's registry, not a trusted source.
  check('shim-registered tools are gated too', registry.tools().every((t) => t.requiresApproval === true), registry.tools());
}

// ---------------------------------------------------------------------------
console.log('\n8. connect.js wiring: probe order and collisions');
// ---------------------------------------------------------------------------
{
  const documentContext: ModelContextLike = { registerTool: () => Promise.resolve(undefined) };
  const navigatorContext: ModelContextLike = { registerTool: () => Promise.resolve(undefined) };
  const harvester = createWebMcpHarvester({
    document: { modelContext: documentContext },
    navigator: { modelContext: navigatorContext },
  });

  void navigatorContext.registerTool?.(tool({ name: 'navigator.ignored' }));
  void documentContext.registerTool?.(tool({ name: 'doc.read' }));
  void documentContext.registerTool?.(tool({
    name: 'doc.delete',
    description: 'Delete the document',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    execute(this: unknown, args: Record<string, unknown>) {
      return { deleted: args['id'], sawThis: this !== undefined };
    },
  }));
  await deadline(settled(), 'site registrations');

  const harvested = harvester.harvest();
  check('harvests both document registrations', harvested.length === 2, harvested.map((t) => t.name));
  check(`prefers ${WEBMCP.getter} over ${WEBMCP.legacyGetter}`, !harvested.some((t) => t.name === 'navigator.ignored'));
  check('maps description', harvested.find((t) => t.name === 'doc.read')?.description === 'Read the document');
  check('every harvested tool is gated', harvested.every((t) => t.requiresApproval === true), harvested);

  const deleteTool = harvested.find((t) => t.name === 'doc.delete');
  const result = (await deadline(Promise.resolve(deleteTool?.handler({ id: 'doc-7' })), 'handler')) as Record<string, unknown>;
  check('execute() round-trips through the handler', result?.['deleted'] === 'doc-7', result);
  check('execute() is called with the descriptor as `this`', result?.['sawThis'] === true, result);

  // The site's own connect() tools win a collision and keep their own gating:
  // those came from an integration written against us, and the harvest rule
  // must not reach into them.
  const explicit: SiteTool = {
    name: 'doc.read',
    description: 'Explicit read',
    inputSchema: { type: 'object' },
    handler: () => ({ text: 'explicit' }),
  };
  const merged = harvester.harvest([explicit]);
  const mergedRead = merged.find((t) => t.name === 'doc.read');
  check('explicit tool wins the name collision', mergedRead === explicit, mergedRead);
  check('the collision leaves exactly one tool with that name', merged.filter((t) => t.name === 'doc.read').length === 1);
  check('an explicit tool keeps its own gating', mergedRead?.requiresApproval === undefined, mergedRead);
}

// ---------------------------------------------------------------------------
console.log('\n9. connect.js falls back to the deprecated spelling');
// ---------------------------------------------------------------------------
{
  const navigatorContext: ModelContextLike = { registerTool: () => Promise.resolve(undefined) };
  const harvester = createWebMcpHarvester({ navigator: { modelContext: navigatorContext } });
  void navigatorContext.registerTool?.(tool({ name: 'legacy.update', description: 'Legacy update', execute: () => 'legacy-result' }));
  await deadline(settled(), 'legacy registration');

  const fallback = harvester.harvest();
  check(`uses ${WEBMCP.legacyGetter} when the document spelling is absent`, fallback[0]?.name === 'legacy.update', fallback);
  check('a write-sounding legacy name is gated like everything else', fallback[0]?.requiresApproval === true, fallback[0]);
  check('the legacy handler round-trips', (await deadline(Promise.resolve(fallback[0]?.handler({})), 'legacy handler')) === 'legacy-result');

  // connect.js never installs a shim: a site that loaded connect.js declares
  // its tools through connect(), so a second way to say the same thing would
  // be a parallel path.
  const empty: { document?: { modelContext?: unknown }; navigator?: { modelContext?: unknown } } = {};
  createWebMcpHarvester(empty);
  check('connect.js does not install a model context', empty.document?.modelContext === undefined && empty.navigator?.modelContext === undefined, empty);
}

// ---------------------------------------------------------------------------
console.log('\n10. the recorded gaps are real gaps');
// ---------------------------------------------------------------------------
//
// `WEBMCP_NOT_IMPLEMENTED` is the honest half of ADR-006's claim, and a
// constant nobody reads rots quieter than code. So the two entries that are
// observable get asserted here, and the whole list is printed on every run —
// the check's job includes putting the gaps in front of whoever ran it.
{
  const registry = createWebMcpRegistry();
  let executeToolCalls = 0;
  const context: ModelContextLike & { executeTool?: (...args: unknown[]) => unknown } = {
    registerTool: () => Promise.resolve(undefined),
    getTools: () => [{ name: 'early.one', description: 'Registered before us', inputSchema: '{}', origin: 'https://site.example' }],
    executeTool: () => {
      executeToolCalls += 1;
      return 'executed natively';
    },
  };
  registry.observe(context);
  void context.registerTool?.(tool({ name: 'doc.read' }));
  await deadline(settled(), 'gap registrations');

  const harvested = registry.tools();
  await deadline(Promise.resolve(harvested[0]?.handler({})), 'handler through the page');
  check(
    'executeTool() is never called — specified now, but lending unseen registrations is its own decision',
    executeToolCalls === 0,
    { executeToolCalls },
  );
  check(
    'getTools() never becomes a source of lendable tools',
    !harvested.some((t) => t.name === 'early.one'),
    harvested.map((t) => t.name),
  );
  console.log('  recorded gaps (ADR-006):');
  for (const gap of WEBMCP_NOT_IMPLEMENTED) console.log(`    · ${gap}`);
}

// ---------------------------------------------------------------------------
console.log('\n11. a legacy MCP-B envelope is unwrapped, not forwarded as data');
// ---------------------------------------------------------------------------
//
// Sites from the MCP-B era return CallToolResult envelopes from execute();
// forwarding the envelope made the agent reason about a transport wrapper —
// a silent degradation on exactly the population that adopted earliest. Only
// shapes we can normalize without guessing are touched.
{
  const registry = createWebMcpRegistry();
  const shim = registry.shim('https://site.example') as ModelContextLike;
  const outcomes = new Map<string, unknown>([
    ['env.text', { content: [{ type: 'text', text: 'plain answer' }] }],
    ['env.multi', { content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] }],
    ['env.structured', { content: [{ type: 'text', text: 'shadow' }], structuredContent: { total: 7 } }],
    ['env.error', { content: [{ type: 'text', text: 'the cart is locked' }], isError: true }],
    ['env.media', { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }],
    ['env.plain', { text: 'not an envelope' }],
  ]);
  for (const [name, outcome] of outcomes) {
    await deadline(
      Promise.resolve(shim.registerTool?.(tool({ name, execute: () => outcome }))),
      `register ${name}`,
    );
  }
  await deadline(settled(), 'envelope registrations');
  // async, not Promise.resolve(call): a handler that throws SYNCHRONOUSLY is
  // legitimate (that is what isError normalizes into when execute returned a
  // plain value), and only an async wrapper turns that into a rejection the
  // deadline can race instead of a crash before any promise exists.
  const run = async (name: string) => registry.get(name)?.handler({});

  check('an all-text envelope yields its text', (await deadline(run('env.text'), 'env.text')) === 'plain answer');
  check('multiple text items join as lines', (await deadline(run('env.multi'), 'env.multi')) === 'line one\nline two');
  check(
    'structuredContent wins over the text shadow',
    JSON.stringify(await deadline(run('env.structured'), 'env.structured')) === '{"total":7}',
  );
  let thrown = '';
  await deadline(run('env.error'), 'env.error').catch((err: unknown) => {
    thrown = err instanceof Error ? err.message : String(err);
  });
  check('isError becomes a FAILED call, not a success-shaped blob', thrown === 'the cart is locked', thrown);
  const media = await deadline(run('env.media'), 'env.media');
  check(
    'a media envelope passes through untouched — normalizing the unknown is repair',
    JSON.stringify(media) === JSON.stringify(outcomes.get('env.media')),
    media,
  );
  const plain = await deadline(run('env.plain'), 'env.plain');
  check('a non-envelope result is untouched', JSON.stringify(plain) === '{"text":"not an envelope"}', plain);
  // The pure function is exported for exactly this direct case: a thrown
  // error must not depend on the handler plumbing above.
  check(
    'normalizeToolResult is identity on arrays',
    JSON.stringify(normalizeToolResult([1, 2])) === '[1,2]',
  );
}

// ---------------------------------------------------------------------------
console.log('\n12. a change after harvest is surfaced, and goes no further');
// ---------------------------------------------------------------------------
//
// The grant is a snapshot at attach; until the grant.update frame exists a
// later registration cannot reach a live session. Silent staleness is the
// invisible-diminishment shape, so the harvester says it out loud — and only
// AFTER a harvest, because registrations during page load are just a page
// loading.
{
  const { logger, lines } = recorder();
  const context: ModelContextLike = { registerTool: () => Promise.resolve(undefined) };
  const harvester = createWebMcpHarvester({ document: { modelContext: context } }, { logger });
  void context.registerTool?.(tool({ name: 'doc.early' }));
  await deadline(settled(), 'pre-harvest registration');
  check(
    'a registration during page load is not stale-flagged',
    !lines.some((line) => line.message.includes('frozen until grant.update')),
    lines.map((line) => line.message),
  );
  harvester.harvest();
  void context.registerTool?.(tool({ name: 'doc.late', description: 'Registered after attach' }));
  await deadline(settled(), 'post-harvest registration');
  const stale = lines.find((line) => line.message.includes('frozen until grant.update'));
  check('a registration after harvest is surfaced as staleness', stale !== undefined && stale.level === 'info', lines.map((line) => line.message));
}

console.log(failures === 0 ? `\nWebMCP harvest passed (draft ${WEBMCP.draft})` : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
