/**
 * Job 2 — the fallback surface, as one object that owns its own state.
 *
 * When the site does not speak `navigator.agent`, the extension becomes the
 * surface. Preference order for what the agent gets:
 *
 *   1. the site's own WebMCP tools, if it registered any — those carry intent;
 *   2. otherwise the generic `page.*` DOM toolset.
 *
 * Either way the grant goes through the same consent screen and the same
 * per-call approvals as a site-declared grant.
 *
 * A widget attachment outlives a same-origin navigation: the next document asks
 * the worker to hand it back (`reclaim()`, at document_start) and rehydrates the
 * transcript from the agent's own store. Only the generic toolset can do that —
 * a grant harvested from a document's own WebMCP registrations belongs to THAT
 * document, so the worker refuses to park it. Leaving the origin is not a
 * navigation the attachment follows at all: the worker closes it when this tab's
 * next top-level document announces a different origin.
 *
 * WHY THIS IS AN OBJECT, AND WHY IT TAKES ITS DEPENDENCIES
 *
 * This was eleven module-scope variables in `content.ts` maintained by
 * convention across ten functions, and every hazard described below — a plan
 * arriving for a turn this document is not running, a `reattached` landing
 * before any panel exists, a history replay racing live output, a late frame
 * for an attachment that has already gone — was a cross-check between two of
 * them. None of it could be reached from a check without a real browser, so the
 * only evidence those transitions worked was that nobody had reported them
 * broken.
 *
 * So the state lives in one object and everything browser-shaped is injected:
 * the panel (an `OverlayHost`, because building an extension-origin iframe
 * inside a closed shadow root is `chrome.runtime` work the content script owns),
 * the two calls to the service worker, the mediator's routing table, and the few
 * facts about the document. Nothing in this file touches `chrome`, `document` or
 * `window`, which is what lets `packages/extension/check.ts` drive the
 * transitions directly. Same seam as `lifecycle.ts`: the rules move to where
 * they can be asserted, the plumbing stays where it is.
 */

import type { SiteTool } from '@agentport/client';
import {
  createLogger,
  type HistoryEntry,
  type Logger,
  type PlanStep,
  type ToolDefinition,
} from '@agentport/protocol';
import type { ChatUpdate } from '../../../src/nisli-ui/ui/chat/index.js';
import {
  isRecord,
  mintId,
  sanitizePlanSteps,
  type ContentToWorker,
  type PageConnectRequest,
} from './bridge.js';
import type { WidgetPhase } from './overlay.js';

/** The agent's own store answers this; a runtime that never answers must not
 *  leave the reattached widget waiting on a promise nobody settles. */
const HISTORY_TIMEOUT_MS = 20_000;

/**
 * Where the tools in a widget grant came from. `page-dom` is the extension's
 * own harness and is the only kind the worker will park across a navigation;
 * `lifecycle.ts` is where that rule is written down.
 */
export type WidgetToolSource = 'webmcp' | 'page-dom';

/**
 * How a tool call for a bound session is answered: by the page that declared
 * the tool, or by a handler this extension synthesised. Declared here because
 * the widget is the only surface that produces the second kind; the mediator's
 * routing table composes it.
 */
export type ToolRoute = 'page' | ((args: Record<string, unknown>) => unknown | Promise<unknown>);

/** Semantic commands to whatever is drawing this attachment. */
export interface OverlayBridge {
  show(): void;
  setState(phase: WidgetPhase, agentName?: string): void;
  addUserMessage(content: string): void;
  apply(update: ChatUpdate): void;
  notice(text: string): void;
  /** Replace the agent's checklist. An empty array clears it. */
  plan(steps: readonly PlanStep[]): void;
  /** Fingerprint words for the current attachment; '' hides the line. */
  verify(words: string): void;
  reset(): void;
}

/**
 * The panel, as this state machine is allowed to see it.
 *
 * Two members, and the split between them is load-bearing. `open()` builds one
 * on first use — that is what a user pressing Attach means. `panel()` never
 * builds: a frame arriving from the worker must be able to ask "is there
 * anywhere to draw this yet" without conjuring an iframe as a side effect,
 * because a reclaim binds an attachment at document_start when the answer is
 * legitimately no.
 */
export interface OverlayHost {
  open(): OverlayBridge;
  panel(): OverlayBridge | undefined;
}

/**
 * The document, reduced to the handful of facts a grant is made of.
 *
 * Injected rather than read from globals so this module has no ambient
 * dependency at all — the class is then constructible in Node with no DOM
 * stand-in, which is the difference between a hazard that has a check and a
 * hazard that has a comment.
 */
export interface WidgetPage {
  /** Surface metadata plus the tools being lent, as the consent window will
   *  name them. `source` is how the worker knows whether this grant can outlive
   *  the document that declared it. */
  connectRequest(tools: ToolDefinition[], source: WidgetToolSource): PageConnectRequest;
  /** WebMCP tools the page has registered, harvested by the in-page script. */
  webmcpTools(): ToolDefinition[];
  /** The extension's own generic DOM harness. */
  genericTools(): SiteTool[];
  /** Resolves once this document can carry a panel. */
  ready(): Promise<void>;
  /** Log context only, never authority: the origin that decides anything is the
   *  one the browser stamps on the worker port. */
  origin(): string;
}

/** What the worker hands back for a fresh attach and a reclaim alike. */
export interface WidgetAttachment {
  ref: string;
  info: { agentName: string; verify?: string };
  /** Turns the agent is still working on, so a document that arrives mid-turn
   *  renders a running turn instead of an idle composer. */
  activePrompts?: string[];
  /** The plan of the turn in flight, when the worker is holding one. */
  plan?: unknown;
}

export interface WidgetSurfaceOptions {
  host: OverlayHost;
  page: WidgetPage;
  /** Fire-and-forget to the service worker. */
  tell(message: ContentToWorker): void;
  /** Request/response against the service worker, by minted rid. */
  request<T>(build: (rid: string) => ContentToWorker, timeoutMs?: number): Promise<T>;
  /** Hand the mediator the routes for a session it must now answer for. The
   *  widget never removes them: a record dies when the worker says the session
   *  closed, which is the mediator's own bookkeeping. */
  bindSession(ref: string, routes: Map<string, ToolRoute>): void;
  log?: Logger;
}

function displayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Close reasons are stable protocol codes, so most render as-is. The one that
 * needs words is `seal_violation` (ADR-019): a sealed frame failed strict
 * validation, and because the AEAD counters advance in lockstep the session
 * cannot skip a frame and survive — the wallet tore it down. Re-attaching is
 * safe and mints fresh keys; the user should know that, not guess it.
 */
function detachNotice(reason: string): string {
  return reason === 'seal_violation'
    ? 'Detached: encrypted traffic in this session failed verification, so it was shut down for safety. Attach again to start a fresh session.'
    : `Detached: ${reason}`;
}

export class WidgetSurface {
  readonly #host: OverlayHost;
  readonly #page: WidgetPage;
  readonly #tell: (message: ContentToWorker) => void;
  readonly #request: <T>(build: (rid: string) => ContentToWorker, timeoutMs?: number) => Promise<T>;
  readonly #bindSession: (ref: string, routes: Map<string, ToolRoute>) => void;
  readonly #log: Logger;

  /** The attachment this document drives. `undefined` is the whole of "not
   *  attached", and every late frame is judged against it. */
  #ref: string | undefined;
  /** The turn THIS document believes is running. */
  #promptId: string | undefined;
  #attaching = false;
  #toolSeq = 0;
  /** Set as soon as the agent says anything to THIS document. A history replay
   *  must never overwrite a transcript the user is already reading. */
  #liveSinceBind = false;
  readonly #textMessages = new Set<string>();
  readonly #reasoningMessages = new Set<string>();
  /**
   * State of the CURRENT attachment, held here rather than only in the panel.
   *
   * The panel does not exist yet at document_start, which is exactly when
   * `reclaim()` binds a session that may already be mid-turn — and a `reset`
   * during a history replay clears it. Keeping the values here means
   * `#showAttached` can restate them whenever the panel appears or is cleared,
   * instead of the user losing a plan or a set of fingerprint words to a timing
   * accident.
   */
  #plan: readonly PlanStep[] = [];
  #verify = '';

  constructor(options: WidgetSurfaceOptions) {
    this.#host = options.host;
    this.#page = options.page;
    this.#tell = options.tell;
    this.#request = options.request;
    this.#bindSession = options.bindSession;
    this.#log = options.log ?? createLogger('extension.widget');
  }

  // --- attaching -----------------------------------------------------------

  /** The user pressed Attach in the panel. */
  async attach(): Promise<void> {
    const ui = this.#host.open();
    if (this.#ref || this.#attaching) return;
    this.#attaching = true;
    ui.setState('attaching');

    const usingWebMcp = this.#page.webmcpTools().length > 0;
    const local: SiteTool[] = usingWebMcp ? [] : this.#page.genericTools();
    const definitions: ToolDefinition[] = usingWebMcp
      ? this.#page.webmcpTools()
      : local.map(({ handler: _handler, ...definition }) => definition);

    try {
      const value = await this.#request<WidgetAttachment>((rid) => ({
        t: 'connect',
        rid,
        from: 'widget',
        request: this.#page.connectRequest(definitions, usingWebMcp ? 'webmcp' : 'page-dom'),
      }));

      // The panel went away while the consent window was open. There is nothing
      // to draw the attachment in, so hand it straight back.
      if (!this.#host.panel()) {
        this.#attaching = false;
        this.#tell({ t: 'close', ref: value.ref, reason: 'widget_removed' });
        return;
      }

      const routes = new Map<string, ToolRoute>();
      // TODO(behaviour preserved, not endorsed): these read the page's CURRENT
      // registrations, while `definitions` above — the grant the daemon will
      // enforce — was snapshotted before the await. A page that re-registers
      // its WebMCP tools while the consent window is open therefore gets routes
      // that do not match its grant: an extra route is unreachable (the daemon
      // refuses a tool absent from the grant) but a granted tool can end up with
      // no route and answer "unknown tool". Fixing it means routing from the
      // snapshot, which changes what happens in that race, so it is named here
      // rather than folded into a refactor that claims to change nothing.
      if (usingWebMcp) for (const tool of this.#page.webmcpTools()) routes.set(tool.name, 'page');
      else for (const tool of local) routes.set(tool.name, tool.handler);

      this.#bind(value.ref, routes);
      // A fresh attachment: fresh sealing keys, and no turn yet to have a plan.
      this.#verify = typeof value.info.verify === 'string' ? value.info.verify : '';
      this.#plan = [];
      this.#showAttached(ui, value.info.agentName);
      ui.notice(
        usingWebMcp
          ? `Attached with ${this.#page.webmcpTools().length} tool(s) this site published via WebMCP. This grant ends when you leave this page.`
          : `Attached with the generic page toolset. Reads are free; anything that changes the page asks first.`,
      );
    } catch (err) {
      this.#attaching = false;
      if (!this.#host.panel()) return;
      ui.setState('idle');
      ui.notice(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Ask the worker whether this tab already has an attachment on this origin.
   *
   * Runs at document_start on every top-level page, before the panel exists, for
   * two reasons: a tool call the agent issued just before the navigation is
   * parked in the worker waiting for a document to bind, and opening that port
   * is also how the worker learns which origin the tab is on now — which is what
   * makes a cross-origin navigation detach immediately instead of after the
   * orphan grace.
   */
  async reclaim(): Promise<void> {
    if (this.#ref || this.#attaching) return;
    this.#attaching = true;
    const local = this.#page.genericTools();
    let value: WidgetAttachment | null;
    try {
      value = await this.#request<WidgetAttachment | null>((rid) => ({
        t: 'resume',
        rid,
        from: 'widget',
        request: this.#page.connectRequest(
          local.map(({ handler: _handler, ...definition }) => definition),
          'page-dom',
        ),
      }));
    } catch (err) {
      this.#attaching = false;
      this.#log.warn('could not ask the wallet whether this tab has an attachment to reclaim', {
        err,
        data: { origin: this.#page.origin() },
      });
      return;
    }
    if (!value) {
      this.#attaching = false;
      return;
    }

    // Route bindings first: the parked tool call is answered from here, and it
    // must not wait for the DOM or the panel.
    this.#bind(value.ref, new Map(local.map((tool) => [tool.name, tool.handler])));
    const active = value.activePrompts?.[0];
    if (typeof active === 'string') this.#promptId = active;
    // The attachment survived the navigation; so does what it was doing. The
    // worker held both, because this document kept nothing across the boundary.
    this.#verify = typeof value.info.verify === 'string' ? value.info.verify : '';
    if (value.plan === undefined) {
      this.#plan = [];
    } else {
      const steps = sanitizePlanSteps(value.plan);
      if (steps) {
        this.#plan = steps;
      } else {
        // Only our own plumbing can produce this — the snapshot passed the wire
        // schema before the worker ever held it. Show no plan rather than a
        // mangled one, and say so, because it means these two halves disagree.
        this.#plan = [];
        this.#log.error('the wallet handed back a plan this document cannot render', {
          data: { origin: this.#page.origin() },
        });
      }
    }

    await this.#page.ready();
    if (this.#ref !== value.ref) return; // detached or closed while we waited
    const ui = this.#host.open();
    ui.show();
    this.#showAttached(ui, value.info.agentName);
    ui.notice('Reattached after navigation — same agent, same session.');
    await this.#rehydrate(ui, value.ref, value.info.agentName);
  }

  #bind(ref: string, routes: Map<string, ToolRoute>): void {
    this.#bindSession(ref, routes);
    this.#ref = ref;
    this.#attaching = false;
    this.#liveSinceBind = false;
  }

  #showAttached(ui: OverlayBridge, agentName: string): void {
    ui.setState('attached', agentName);
    // The one place the attachment's own state is put on screen. It runs on a
    // fresh attach, on a reclaim after navigation, and after a history replay's
    // `reset` — so a plan and a set of fingerprint words are never lost to
    // whichever of those happened to come last.
    ui.verify(this.#verify);
    ui.plan(this.#plan);
    // A turn was already running when this document arrived; render it as such
    // so the composer offers Stop instead of pretending the agent is idle.
    if (this.#promptId) ui.apply({ type: 'run.start' });
  }

  /** The transcript lives in the agent's own store, never here: this document
   *  kept nothing across the navigation, so it asks the agent for it. */
  async #rehydrate(ui: OverlayBridge, ref: string, agentName: string): Promise<void> {
    let entries: HistoryEntry[];
    try {
      entries = await this.#request<HistoryEntry[]>((rid) => ({ t: 'history', rid, ref }), HISTORY_TIMEOUT_MS);
    } catch (err) {
      this.#log.warn('could not restore the conversation from the agent', {
        err,
        data: { origin: this.#page.origin() },
      });
      ui.notice(`Could not restore the earlier conversation: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    if (this.#ref !== ref || !Array.isArray(entries) || entries.length === 0) return;
    if (this.#liveSinceBind) {
      // The agent spoke while this was in flight. Replaying now would delete the
      // words the user is reading, so say where the rest is instead.
      ui.notice(`${entries.length} earlier message(s) remain in your agent's own history.`);
      return;
    }
    ui.reset();
    for (const entry of entries) {
      const id = `history-${this.#toolSeq++}`;
      if (entry.role === 'user') {
        ui.addUserMessage(entry.text);
      } else if (entry.role === 'agent') {
        ui.apply({ type: 'message.start', id, role: 'assistant' });
        ui.apply({ type: 'message.delta', id, content: { type: 'text', text: entry.text } });
        ui.apply({ type: 'message.end', id });
      } else if (entry.role === 'thought') {
        ui.apply({ type: 'reasoning.start', id });
        ui.apply({ type: 'reasoning.delta', id, content: { type: 'text', text: entry.text } });
        ui.apply({ type: 'reasoning.end', id });
      } else {
        // Tool and approval rows arrive as flat text.
        ui.apply({ type: 'tool.start', id, name: entry.text });
        ui.apply({ type: 'tool.end', id, status: 'complete' });
      }
    }
    // A `reset` also clears the phase and the notices, so restate both.
    this.#showAttached(ui, agentName);
    ui.notice(`Reattached after navigation — ${entries.length} message(s) restored from your agent.`);
  }

  // --- driving a turn ------------------------------------------------------

  /** The user submitted in the panel's composer. `false` means "not accepted",
   *  which the panel renders instead of clearing the box. */
  send(text: string): boolean {
    const ui = this.#host.panel();
    const ref = this.#ref;
    if (!ui || !ref || this.#promptId) return false;
    const promptId = mintId('p_');
    this.#promptId = promptId;
    ui.apply({ type: 'run.start' });
    this.#request<string>((rid) => ({ t: 'prompt', rid, ref, promptId, text })).then(
      (full) => {
        // `done` normally settles the run first. This fallback is for a worker
        // that returned a result after losing its event subscription.
        if (this.#promptId !== promptId) return;
        if (full && !this.#textMessages.has(promptId)) {
          this.#textMessages.add(promptId);
          ui.apply({ type: 'message.start', id: promptId, role: 'assistant' });
          ui.apply({ type: 'message.delta', id: promptId, content: { type: 'text', text: full } });
          ui.apply({ type: 'message.end', id: promptId });
        }
        ui.apply({ type: 'run.end' });
        this.#promptId = undefined;
      },
      (err: Error) => {
        if (this.#promptId !== promptId) return;
        ui.apply({ type: 'run.error', error: err.message });
        ui.notice(err.message);
        this.#promptId = undefined;
      },
    );
    return true;
  }

  /** The user pressed Stop. */
  cancel(): void {
    if (this.#ref && this.#promptId) this.#tell({ t: 'prompt.cancel', ref: this.#ref, promptId: this.#promptId });
  }

  /** The user pressed Detach. The worker is told; the record itself dies when
   *  the worker's `closed` comes back. */
  detach(): void {
    if (this.#ref) this.#tell({ t: 'close', ref: this.#ref, reason: 'user_detached' });
    this.#ref = undefined;
    this.#promptId = undefined;
    this.#plan = [];
    this.#verify = '';
    this.#host.open().reset();
  }

  /**
   * The panel itself is gone — the page removed our host element, or the frame
   * reloaded out from under the port. Everything here described an attachment
   * that now has no surface, so it is dropped and the attachment handed back.
   */
  surfaceLost(reason: string): void {
    const ref = this.#ref;
    this.#ref = undefined;
    this.#promptId = undefined;
    this.#attaching = false;
    this.#textMessages.clear();
    this.#reasoningMessages.clear();
    this.#plan = [];
    this.#verify = '';
    if (ref) this.#tell({ t: 'close', ref, reason });
  }

  // --- frames from the worker ----------------------------------------------

  event(name: string, payload: unknown): void {
    if (name === 'closed') {
      const reason = isRecord(payload) ? String(payload['reason'] ?? 'closed') : 'closed';
      this.closed(reason);
      return;
    }
    if (!isRecord(payload)) return;
    const promptId = typeof payload['promptId'] === 'string' ? payload['promptId'] : undefined;

    // `plan` and `reattached` describe the ATTACHMENT, not the conversation, so
    // they are recorded before the panel is consulted: a reclaim binds at
    // document_start, long before any iframe exists, and losing a plan or the
    // current fingerprint words to that gap is not acceptable. They also
    // deliberately do not set `#liveSinceBind` — neither is something the agent
    // said, so neither may suppress the history replay.
    if (name === 'plan' || name === 'reattached') {
      if (!this.#ref) {
        // The user hit Detach (or this document never bound) and the worker's
        // `closed` is still in flight. Nothing here belongs to a live
        // attachment, so render none of it — showing fingerprint words for a
        // session that is going away is worse than showing nothing.
        this.#log.info('ignored attachment state for a widget that is not attached', { data: { event: name } });
        return;
      }
      if (name === 'plan') this.#applyPlan(promptId, payload['steps']);
      else this.#reattached(payload['verify']);
      return;
    }

    const ui = this.#host.panel();
    if (!ui) return;
    this.#liveSinceBind = true;
    if (name === 'delta' && promptId) {
      if (!this.#textMessages.has(promptId)) {
        this.#textMessages.add(promptId);
        ui.apply({ type: 'message.start', id: promptId, role: 'assistant' });
      }
      ui.apply({ type: 'message.delta', id: promptId, content: { type: 'text', text: String(payload['text'] ?? '') } });
    } else if (name === 'thought' && promptId) {
      const id = `${promptId}:reasoning`;
      if (!this.#reasoningMessages.has(id)) {
        this.#reasoningMessages.add(id);
        ui.apply({ type: 'reasoning.start', id });
      }
      ui.apply({ type: 'reasoning.delta', id, content: { type: 'text', text: String(payload['text'] ?? '') } });
    } else if (name === 'tool') {
      const id = `tool-${this.#toolSeq++}`;
      const ok = payload['ok'] === true;
      ui.apply({
        type: 'tool.start',
        id,
        name: String(payload['name'] ?? 'Tool call'),
        input: displayJson(payload['arguments'] ?? {}),
      });
      ui.apply({
        type: 'tool.end',
        id,
        status: ok ? 'complete' : 'error',
        output: ok && payload['result'] !== undefined
          ? [{ type: 'text', text: displayJson(payload['result']) }]
          : undefined,
        error: ok ? undefined : String(payload['error'] ?? 'Tool call failed'),
      });
    } else if (name === 'done' && promptId) {
      if (this.#textMessages.delete(promptId)) ui.apply({ type: 'message.end', id: promptId });
      const reasoningId = `${promptId}:reasoning`;
      if (this.#reasoningMessages.delete(reasoningId)) ui.apply({ type: 'reasoning.end', id: reasoningId });
      const failed = payload['stopReason'] === 'error';
      ui.apply(failed
        ? { type: 'run.error', error: String(payload['error'] ?? 'Agent run failed') }
        : { type: 'run.end' });
      if (this.#promptId === promptId) {
        this.#promptId = undefined;
        // The turn is over, so its checklist stops being what the agent intends.
        // Leaving it up would advertise finished work as current, and the next
        // turn may produce no plan at all to replace it. (The site panel keeps a
        // finished plan on screen; that is a bug there, not a difference worth
        // reproducing.)
        if (this.#plan.length > 0) {
          this.#plan = [];
          ui.plan([]);
        }
      }
    }
  }

  /**
   * A plan snapshot for the turn this document believes is running.
   *
   * Replaces the checklist outright — never appended to the transcript, because
   * a plan is revised as the agent discovers work and every revision replayed as
   * a message would read as repetition rather than as progress.
   */
  #applyPlan(promptId: string | undefined, steps: unknown): void {
    if (!promptId || promptId !== this.#promptId) {
      // The turn ended (`done` cleared `#promptId`) or this plan belongs to one
      // this document never picked up. Rendering it would put a checklist of
      // intentions above a composer that is idle, so it is dropped — and said
      // out loud, because a plan for an unknown turn means this document and the
      // worker disagree about what is running.
      this.#log.warn('dropped a plan for a turn this document is not running', {
        data: { promptId: promptId ?? 'missing', running: this.#promptId ?? 'none' },
      });
      return;
    }
    const next = sanitizePlanSteps(steps);
    if (!next) {
      // The snapshot passed the wire schema before the wallet ever saw it, so
      // this can only be our own plumbing corrupting it. Keep the last good plan
      // rather than replace it with a fabricated one, and report it.
      this.#log.error('dropped a plan snapshot that failed validation inside the extension', {
        data: { promptId },
      });
      return;
    }
    this.#plan = next;
    this.#host.panel()?.plan(next);
  }

  /**
   * The socket dropped and the wallet put this attachment back on a fresh one.
   *
   * The fingerprint words CHANGE here: ADR-003 mints a new ephemeral keypair per
   * attachment, so anyone comparing them against their daemon's consent screen
   * is now comparing against stale ones. They are therefore persistent state,
   * not a notice that scrolls away.
   */
  #reattached(words: unknown): void {
    this.#verify = typeof words === 'string' ? words : '';
    // The turn that was in flight lost its answer, so its plan describes nothing.
    this.#plan = [];
    const lost = this.#promptId;
    this.#promptId = undefined;

    const ui = this.#host.panel();
    if (!ui) {
      // No panel yet — a reclaim binds this session at document_start. The state
      // set above is what `#showAttached` puts on screen when one appears, so
      // nothing is lost; it is only late.
      this.#log.info('reattached on fresh sealing keys before this document had a panel', {
        data: { origin: this.#page.origin(), lostTurn: Boolean(lost) },
      });
      return;
    }
    ui.verify(this.#verify);
    ui.plan([]);
    if (!lost) {
      ui.notice('Reconnected — your agent is back, on new sealing keys.');
      return;
    }
    // Settle the run here rather than waiting for the worker's rejection of that
    // prompt: `#promptId` has already moved on, so `send`'s error handler will
    // ignore that reply and the user is told once, not twice. Told, though —
    // the answer really is gone, and only the agent's own store has what it did
    // while nobody was listening.
    ui.apply({ type: 'run.end' });
    ui.notice('Reconnected on new sealing keys. The turn in flight lost its answer — ask again, or check your agent’s own history.');
  }

  /** The attachment is over, from the worker or from the mediator's own
   *  teardown. Nothing left here describes a live attachment. */
  closed(reason: string): void {
    this.#ref = undefined;
    this.#promptId = undefined;
    this.#attaching = false;
    this.#textMessages.clear();
    this.#reasoningMessages.clear();
    // `reset` below clears the panel's copy; these are the source it would
    // otherwise be restated from.
    this.#plan = [];
    this.#verify = '';
    const ui = this.#host.panel();
    ui?.reset();
    ui?.notice(detachNotice(reason));
  }
}
