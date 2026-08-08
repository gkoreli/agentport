/**
 * WebMCP, as we believe it to be — the whole belief, in one file.
 *
 * Two surfaces harvest a page's WebMCP registrations: connect.js
 * (`site/src/webmcp.ts`) and the extension's page-world provider
 * (`packages/extension/src/inpage.ts`). Until this file existed the belief
 * lived in both of them, so the draft could move and only one copy would
 * notice — which is exactly what happened: both were still wrapping
 * `provideContext()`, removed from the draft on 2026-03-05, five months before
 * anybody looked.
 *
 * An internal registry can be made compiler-exhaustive (see the `FRAME_SCHEMAS`
 * note in AGENTS.md). Someone else's draft cannot: there is nothing to be
 * exhaustive *against*, and "re-read the spec periodically" is a process, and
 * processes rot. So the next best thing — one artifact, so a person diffing
 * the draft against us reads ONE file instead of auditing scattered code. If
 * you change what we accept or produce, change it HERE; both harvesters are
 * wiring.
 *
 * Written against the Web Machine Learning Community Group draft dated
 * **2026-07-28** (https://webmachinelearning.github.io/webmcp/), reviewed in
 * `docs/reviews/webmcp-conformance.md`. That document is a Draft Community
 * Group Report: not a W3C Recommendation, not on the standards track, shipped
 * experimentally in Chrome only, WebKit opposed, Mozilla neutral. It moves —
 * `provideContext()`/`clearContext()` removed 2026-03-05, `AbortSignal` added
 * 2026-03-26, `title` + MCP-compatible names 2026-04-09, `untrustedContentHint`
 * 2026-04-23, the getter moved to `Document` 2026-05-27, `registerTool()`
 * became promise-returning 2026-06-08, `ModelContextClient` removed
 * 2026-06-11.
 *
 * Read `WEBMCP` below for the machine-readable half of the belief, and
 * `WEBMCP_NOT_IMPLEMENTED` for the parts we knowingly do not do. Nothing in
 * this file guesses: where the draft is unfinished or a behaviour is only
 * documented for one browser, we decline rather than invent a signature.
 */

import { createLogger, type Logger } from '@agentport/protocol';
import type { SiteTool, ToolHandler } from './session.js';

// ---------------------------------------------------------------------------
// What we believe the contract to be
// ---------------------------------------------------------------------------

/**
 * The load-bearing half of the belief: every value here is read by the code
 * below or asserted by `scripts/webmcp-harvest.ts`. A constant nobody reads is
 * decoration, and decoration rots quieter than code.
 */
export const WEBMCP = Object.freeze({
  /** The draft revision this file was written against. */
  draft: '2026-07-28',
  /** Where the model context lives now. */
  getter: 'document.modelContext',
  /** Where it used to live. Chrome deprecated this in 150; sites still use it. */
  legacyGetter: 'navigator.modelContext',
  /** Tool names: 1–128 chars, ASCII alphanumeric plus `_`, `-`, `.`. */
  namePattern: /^[A-Za-z0-9_.\-]{1,128}$/,
  /** The only annotations the current draft defines. Recorded, never trusted. */
  annotations: Object.freeze(['readOnlyHint', 'untrustedContentHint'] as const),
  /**
   * Members the current draft does not have — `provideContext`/`clearContext`
   * were removed, a public `unregisterTool` never landed. We do not wrap them
   * and we do not offer them; `scripts/webmcp-harvest.ts` asserts the shim
   * exposes none of these, so re-adding one turns a check red.
   */
  absent: Object.freeze(['provideContext', 'clearContext', 'unregisterTool'] as const),
} as const);

/**
 * What we knowingly do not implement, and why. Each entry is a decision, not a
 * TODO list — several of them are "the draft does not say enough to implement
 * without guessing", which is a reason to stop, not a reason to try.
 *
 * Kept beside `WEBMCP` so the honest claim in ADR-006 has exactly one source.
 */
export const WEBMCP_NOT_IMPLEMENTED = Object.freeze([
  'declarative WebMCP — the draft marks its own section TODO',
  'executeTool() — Chrome-only, ahead of the CG IDL, and the draft does not give its signature',
  'getTools() as a source of lendable tools — RegisteredTool carries no execute callback',
  'exposedTo / fromOrigins / the `tools` Permissions Policy — cross-origin frame trees',
  'per-tool owner origin and window in the grant — ToolDefinition has no field for them',
  'title and untrustedContentHint in the grant — ToolDefinition has no field for them',
  'live grant reconciliation — a session grant is a snapshot taken at attach time',
  'MCP CallToolResult normalisation — a legacy MCP-B envelope is forwarded as data',
] as const);

/** The two annotations the current draft defines. Recorded; never authorising. */
export interface WebMcpAnnotations {
  readonly readOnlyHint?: boolean;
  readonly untrustedContentHint?: boolean;
}

/** A descriptor exactly as a page hands it to `registerTool()`. */
export interface WebMcpTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly annotations?: WebMcpAnnotations;
  execute(input: Record<string, unknown>): unknown;
}

/**
 * Registration options. We forward the whole options object to a native
 * implementation untouched and interpret exactly one field, `signal` — which
 * is the draft's ONLY unregistration mechanism.
 */
export interface WebMcpRegisterOptions {
  readonly signal?: AbortSignal;
  /** Forwarded verbatim, never interpreted: see WEBMCP_NOT_IMPLEMENTED. */
  readonly exposedTo?: unknown;
}

/**
 * What `getTools()` produces. Note `inputSchema` is a STRING here and an
 * object on `WebMcpTool` — the draft stringifies it on the way out, and that
 * asymmetry is a real thing to get wrong, so it is spelled out in the types.
 */
export interface WebMcpRegisteredTool {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: string;
  readonly origin: string;
  readonly annotations: WebMcpAnnotations;
}

/**
 * The object at `document.modelContext`. Every member is optional because we
 * meet real implementations, not the IDL: an early Chrome, a site's own
 * polyfill, or our shim.
 */
export interface ModelContextLike {
  registerTool?(tool: unknown, options?: unknown): unknown;
  getTools?(options?: unknown): unknown;
}

/** A registration we accepted, normalised. `execute` is captured once. */
export interface WebMcpRegistration {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: WebMcpAnnotations;
  readonly execute: ToolHandler;
}

/** Why a descriptor was refused. A closed set — no page bytes reach a log. */
export type RefusalReason =
  | 'not_an_object'
  | 'invalid_name'
  | 'missing_description'
  | 'invalid_schema'
  | 'missing_execute';

export type RegistrationRead =
  | { readonly ok: true; readonly value: WebMcpRegistration }
  | { readonly ok: false; readonly reason: RefusalReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Structural, not `instanceof`: the value crossed from the page's realm, where
 * `Promise` and `AbortSignal` are different constructors than ours.
 */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value['then'] === 'function';
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return isRecord(value) && typeof value['addEventListener'] === 'function' && 'aborted' in value;
}

function isJsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    // Cycles and BigInt. Not silence: the caller turns this into a refusal
    // reason and logs it — see `admit`.
    return false;
  }
}

/**
 * Read a page-supplied descriptor, refusing rather than repairing.
 *
 * The old harvesters substituted the name for a missing description and
 * `{type:'object'}` for an invalid schema. That manufactures a tool the
 * browser itself would have rejected (the draft requires a non-empty
 * description and a serializable schema), so the agent could see and call
 * something no conforming WebMCP consumer can. Omitted is still fine —
 * `inputSchema` is genuinely optional — but invalid is refused.
 */
export function readRegistration(value: unknown): RegistrationRead {
  if (!isRecord(value)) return { ok: false, reason: 'not_an_object' };
  const name = value['name'];
  if (typeof name !== 'string' || !WEBMCP.namePattern.test(name)) return { ok: false, reason: 'invalid_name' };
  const description = value['description'];
  if (typeof description !== 'string' || description.length === 0) return { ok: false, reason: 'missing_description' };
  const rawSchema = value['inputSchema'];
  const schemaOmitted = rawSchema === undefined || rawSchema === null;
  if (!schemaOmitted && (!isRecord(rawSchema) || !isJsonSerializable(rawSchema))) {
    return { ok: false, reason: 'invalid_schema' };
  }
  const execute = value['execute'];
  if (typeof execute !== 'function') return { ok: false, reason: 'missing_execute' };

  const title = value['title'];
  const rawAnnotations = isRecord(value['annotations']) ? value['annotations'] : {};
  const annotations: WebMcpAnnotations = {
    ...(typeof rawAnnotations['readOnlyHint'] === 'boolean' ? { readOnlyHint: rawAnnotations['readOnlyHint'] } : {}),
    ...(typeof rawAnnotations['untrustedContentHint'] === 'boolean'
      ? { untrustedContentHint: rawAnnotations['untrustedContentHint'] }
      : {}),
  };
  const call = execute as (input: Record<string, unknown>) => unknown;
  return {
    ok: true,
    value: {
      name,
      ...(typeof title === 'string' && title.length > 0 ? { title } : {}),
      description,
      inputSchema: schemaOmitted ? { type: 'object' } : (rawSchema as Record<string, unknown>),
      annotations,
      // Captured once, and invoked with the descriptor as `this` — the page
      // wrote `execute` as a method and may rely on it.
      execute: (input) => call.call(value, input),
    },
  };
}

/**
 * THE GATING RULE, and the whole reason this function exists in one place.
 *
 * A harvested tool ALWAYS requires per-call approval. Nothing the page wrote
 * is consulted.
 *
 * Everything we know about a harvested tool — its name, its description, its
 * schema, its annotations — was authored by the page. A page is untrusted by
 * standing rule here (see the prompt-injection section of AGENTS.md), and MCP
 * says the same about its own annotation hints: untrusted unless the server is
 * trusted. So there is no page-authored field that may decide whether the user
 * gets asked, and picking one anyway is how `destructiveHint` became an
 * authorization decision: a tool whose page simply omitted the field was
 * ungated, so *missing metadata* granted authority.
 *
 * Note what this rule is NOT. It is not "the page may add approval but never
 * remove it" — that formulation implies the page still has a channel, and
 * with a boolean gate whose default is already the maximum there is nothing
 * left to add. It is also not name-sniffing: guessing "looks like a write"
 * from a string the page chose is the same defect wearing a different field.
 *
 * The relaxation the conformance review recommends is `readOnlyHint === true`
 * AND a trusted user-side origin policy permitting auto-approval. The second
 * half does not exist in this codebase, and shipping only the first half would
 * rebuild the identical hole under a new field name. `readOnlyHint` is
 * therefore recorded on the registration and read by nobody.
 */
export function toSiteTool(registration: WebMcpRegistration): SiteTool {
  return {
    name: registration.name,
    description: registration.description,
    inputSchema: registration.inputSchema,
    requiresApproval: true,
    handler: registration.execute,
  };
}

// ---------------------------------------------------------------------------
// The registry both harvesters wire themselves to
// ---------------------------------------------------------------------------

export interface WebMcpRegistryOptions {
  /** Called after any change to the registered set. */
  onChange?: () => void;
  logger?: Logger;
}

export interface WebMcpRegistry {
  /**
   * Wrap a live implementation so we see what the page registers. Idempotent
   * per context object; wrapping the same one twice does nothing.
   */
  observe(context: ModelContextLike): void;
  /**
   * A stand-in for browsers with no WebMCP at all, shaped like the current
   * draft. `origin` is what its `getTools()` reports as each tool's owner.
   */
  shim(origin: string): ModelContextLike;
  /** The current set, as tools the wallet can lend. */
  tools(): SiteTool[];
  /** One harvested tool by name, for dispatching a call back into the page. */
  get(name: string): SiteTool | undefined;
  size(): number;
}

export function createWebMcpRegistry(options: WebMcpRegistryOptions = {}): WebMcpRegistry {
  const log = options.logger ?? createLogger('webmcp');
  const registrations = new Map<string, WebMcpRegistration>();
  const wrapped = new WeakSet<object>();
  /** Set when `shim()` builds one, so a withdrawal fires `toolchange` too. */
  let shimTarget: EventTarget | null = null;

  const changed = (): void => {
    if (shimTarget) {
      try {
        // The draft's only lifecycle event, and it must cover removals as well
        // as additions — a site that adds a tool on `toolchange` and never
        // hears the matching removal is worse off than one told nothing.
        shimTarget.dispatchEvent(new Event('toolchange'));
      } catch (err) {
        log.error('webmcp toolchange dispatch failed', { err });
      }
    }
    try {
      options.onChange?.();
    } catch (err) {
      // The callback publishes to another world; a throw there must not take
      // down the page's own registerTool() call, which is on the stack.
      log.error('webmcp change listener failed', { err });
    }
  };

  const drop = (name: string, registration: WebMcpRegistration, why: string): void => {
    // Identity, not name: a re-registration under the same name after this
    // signal was handed out must not be deleted by the older signal firing.
    if (registrations.get(name) !== registration) return;
    registrations.delete(name);
    log.info('webmcp tool withdrawn', { data: { tool: name, why } });
    changed();
  };

  /** The draft's ONLY unregistration mechanism, if the page passed one. */
  const signalOf = (rawOptions: unknown): AbortSignal | undefined => {
    if (!isRecord(rawOptions)) return undefined;
    const signal = rawOptions['signal'];
    return isAbortSignal(signal) ? signal : undefined;
  };

  const admit = (tool: unknown, rawOptions: unknown, authoritative: boolean): void => {
    const read = readRegistration(tool);
    if (!read.ok) {
      log.warn('webmcp registration refused', { data: { reason: read.reason } });
      return;
    }
    const registration = read.value;
    // Who owns the duplicate rule depends on who is authoritative. When we
    // wrapped a real implementation, IT decided — a fulfilled registration
    // promise means the browser accepted this name, so our copy is the stale
    // one and gets replaced. When WE are the implementation (the shim), the
    // draft's rule is ours to enforce, and `shim.registerTool` rejects the
    // duplicate before ever reaching here.
    if (!authoritative && registrations.has(registration.name)) {
      log.warn('webmcp duplicate registration refused', { data: { tool: registration.name } });
      return;
    }
    // Checked before the insert, not after: a tool whose signal was already
    // aborted was retracted before we finished adopting it, and adding it only
    // to drop it would announce a change that never happened.
    const signal = signalOf(rawOptions);
    if (signal?.aborted) {
      log.info('webmcp registration arrived already aborted', { data: { tool: registration.name } });
      return;
    }
    registrations.set(registration.name, registration);
    signal?.addEventListener('abort', () => drop(registration.name, registration, 'signal_aborted'), { once: true });
    log.debug('webmcp tool harvested', { data: { tool: registration.name } });
    changed();
  };

  /**
   * Anything already in the native registry when we arrive was registered
   * before our script ran, so we never saw its `execute` and cannot lend it.
   * `getTools()` is how we find out, and saying so is the whole point: a
   * capability we silently miss looks identical to one the site never had.
   */
  const reportPreexisting = (context: ModelContextLike): void => {
    const getTools = context.getTools;
    if (typeof getTools !== 'function') return;
    const note = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      const names = value
        .filter(isRecord)
        .map((entry) => entry['name'])
        .filter((name): name is string => typeof name === 'string' && WEBMCP.namePattern.test(name))
        .filter((name) => !registrations.has(name));
      if (names.length === 0) return;
      log.warn('webmcp tools registered before AgentPort loaded are not lendable', {
        data: { tools: names, why: 'RegisteredTool carries no execute callback' },
      });
    };
    try {
      const result = getTools.call(context);
      // The draft does not pin down whether this is sync or a promise, so
      // tolerate both rather than guess. Either way this only logs.
      if (isThenable(result)) {
        void Promise.resolve(result).then(note, (err: unknown) => {
          log.warn('webmcp getTools() rejected', { err });
        });
        return;
      }
      note(result);
    } catch (err) {
      log.warn('webmcp getTools() threw', { err });
    }
  };

  return {
    observe(context) {
      if (wrapped.has(context)) return;
      const native = context.registerTool;
      if (typeof native !== 'function') {
        // Deliberately NOT marked observed: a site polyfill that installs
        // `registerTool` onto an object it already exposed still gets wrapped
        // the next time a caller observes.
        log.warn('webmcp model context has no registerTool()', {});
        return;
      }
      wrapped.add(context);
      context.registerTool = function (this: unknown, tool: unknown, ...rest: unknown[]): unknown {
        // Forward verbatim. Dropping the second argument — which both
        // harvesters used to do — silently disabled the page's own
        // unregistration and cross-origin exposure in the NATIVE registry.
        const outcome = Reflect.apply(native, this, [tool, ...rest]);
        const registerOptions = rest[0];
        if (isThenable(outcome)) {
          // Current draft: `registerTool()` returns a promise that rejects for
          // duplicate/invalid/disallowed/detached/unserializable registrations.
          // Adopting before it settles lends the agent tools the browser
          // refused, so wait for the browser's verdict.
          void Promise.resolve(outcome).then(
            () => admit(tool, registerOptions, true),
            (err: unknown) => log.info('webmcp registration rejected by the implementation', { err }),
          );
          return outcome;
        }
        // A non-promise return is a pre-2026-06-08 implementation or a site
        // polyfill. Its verdict is unobservable, so we adopt optimistically —
        // the same tier the `navigator` spelling lives in, and the reason
        // `WEBMCP_NOT_IMPLEMENTED` says unregistration is only observed
        // through `options.signal`.
        log.debug('webmcp registerTool() did not return a promise; acceptance unobservable', {});
        admit(tool, registerOptions, false);
        return outcome;
      };
      reportPreexisting(context);
    },

    shim(origin) {
      /**
       * Shaped like the CURRENT draft and nothing else: an EventTarget with a
       * promise-returning `registerTool(tool, options)`, `getTools()`, and the
       * `toolchange` event. No `provideContext`, no `clearContext` — those
       * were removed from the draft in March and a shim that offers them
       * teaches sites to write code no browser will run.
       *
       * What it deliberately omits is in `WEBMCP_NOT_IMPLEMENTED`. A page that
       * needs `exposedTo` or a Permissions Policy is a page we cannot serve
       * honestly, and inventing the semantics would be worse than the gap.
       */
      class ModelContextShim extends EventTarget {
        #ontoolchange: ((event: Event) => void) | null = null;

        get ontoolchange(): ((event: Event) => void) | null {
          return this.#ontoolchange;
        }

        set ontoolchange(listener: ((event: Event) => void) | null) {
          if (this.#ontoolchange) this.removeEventListener('toolchange', this.#ontoolchange);
          this.#ontoolchange = listener;
          if (listener) this.addEventListener('toolchange', listener);
        }

        registerTool(tool: unknown, registerOptions?: unknown): Promise<undefined> {
          const read = readRegistration(tool);
          if (!read.ok) return Promise.reject(new TypeError(`registerTool: ${read.reason}`));
          if (registrations.has(read.value.name)) {
            return Promise.reject(new TypeError(`registerTool: duplicate name ${read.value.name}`));
          }
          // `admit` fires `toolchange` through `changed()`, so the draft's
          // "notifications queued before the promise resolves" holds.
          admit(tool, registerOptions, true);
          return Promise.resolve(undefined);
        }

        getTools(): WebMcpRegisteredTool[] {
          return [...registrations.values()]
            .map((entry) => ({
              name: entry.name,
              ...(entry.title === undefined ? {} : { title: entry.title }),
              description: entry.description,
              // Stringified on the way out, as the draft specifies.
              inputSchema: JSON.stringify(entry.inputSchema),
              origin,
              annotations: entry.annotations,
            }))
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        }
      }
      const instance = new ModelContextShim();
      // The shim IS the implementation, so mark it observed: wrapping our own
      // registerTool would admit every tool twice.
      wrapped.add(instance);
      shimTarget = instance;
      return instance as ModelContextLike;
    },

    tools() {
      return [...registrations.values()].map(toSiteTool);
    },

    get(name) {
      const registration = registrations.get(name);
      return registration ? toSiteTool(registration) : undefined;
    },

    size() {
      return registrations.size;
    },
  };
}
