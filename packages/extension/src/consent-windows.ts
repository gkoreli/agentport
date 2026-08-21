/**
 * Every decision this extension puts to its user, and the discipline that a
 * window nobody answered is a refusal.
 *
 * ADR-009: consent, per-call approvals and the agent's own questions render in
 * an extension-origin popup window — never in page DOM, never in an OS
 * notification. A page can cover an overlay and repaint it pixel-perfectly; it
 * cannot draw into a browser window it does not own. And a platform that
 * suppresses a notification *after* Chrome reports it created leaves the
 * agent's turn unanswered with nobody the wiser.
 *
 * ONE INVARIANT RUNS THROUGH ALL OF IT: a window that is not answered denies.
 * The window failed to open, the user pressed Escape, they closed it, the
 * session it was asking for died, the deadline ran out — every one of those
 * paths settles through `#settle` with `consentDenial(kind)`, and none of them
 * leaves a promise for the agent's turn to hang on. What the refusal IS per
 * kind lives in `CONSENT_DENIAL` (`bridge.ts`), so nothing here re-derives one:
 * a skipped question is not `false`.
 *
 * WHY IT TAKES ITS WINDOW HOST. Same seam as `widget.ts`. The browser-shaped
 * half of this module is three calls — open a popup, close one, hear that one
 * went away — so they are injected, and nothing in this file touches `chrome`.
 * That is what lets `packages/extension/check.ts` watch the fail-closed rule
 * hold and watch a deadline actually fire, instead of taking both on trust
 * because the only way to reach them was a real browser with a paired agent.
 *
 * IT REACHES THE SESSION REGISTRY THROUGH EXACTLY ONE DOOR, `closeFor(ref)`,
 * and never the other way round. The registry (still in `sw.ts`) owns which
 * sessions exist; this module owns which windows are open. A window that
 * outlives the session it was asking for is a form the user fills in for an
 * agent that has stopped listening, which is why that door exists at all.
 */

import {
  Deferred,
  createLogger,
  type AuthorityDomain,
  type FormField,
  type LogContext,
  type Logger,
} from '@agentport/protocol';

import {
  consentDenial,
  isRecord,
  mintId,
  type AgentRow,
  type AnswerField,
  type ConsentPayload,
  type ConsentToWorker,
  type PageConnectRequest,
  type WorkerToConsent,
} from './bridge.js';

/**
 * How long a question window may sit unanswered.
 *
 * Strictly inside the daemon's own `ASK_TIMEOUT_MS` (five minutes;
 * `packages/daemon/src/daemon.ts#ASK_TIMEOUT_MS`), because past that the daemon
 * has already decayed the question to a skip and treats a late answer as a
 * silent no-op — so a longer window here would let someone fill in a form that
 * goes nowhere and never says so.
 */
export const ASK_WINDOW_MS = 4 * 60 * 1000;

/**
 * How long an approval window may sit unanswered.
 *
 * Its own constant beside `ASK_WINDOW_MS` rather than one shared number, for
 * the reason the daemon keeps two (`packages/daemon/src/daemon.ts#APPROVAL_TIMEOUT_MS`):
 * the channels decay in OPPOSITE directions — an unanswered question means
 * "proceed without one", an unanswered decision must mean NO — so a single
 * constant would eventually be moved for one channel's reason and silently
 * change the other channel's meaning.
 *
 * This channel had no deadline at all. A consent window opened on another
 * virtual desktop parked the agent's turn for as long as nobody looked at it,
 * and the daemon's own new deadline only moves that stall five minutes away and
 * far from the user: past it the daemon has already resolved the request as
 * declined, so the window still on screen is offering an Approve button that
 * does nothing. Four minutes, strictly inside the daemon's five, for exactly
 * the reason the question window is four — whatever this window still shows
 * after the far side has decided is a lie about what pressing the button does.
 *
 * Sized against the daemon's DEFAULT, which is all an extension can see: an
 * embedder may pass `approvalTimeoutMs`, and a shorter one there simply means
 * the daemon declines first, which is the safe direction on this channel.
 */
export const APPROVE_WINDOW_MS = 4 * 60 * 1000;

/**
 * The browser's window plumbing, reduced to what a consent surface needs.
 *
 * `onRemoved` is not decoration: it is the fail-closed rule's only evidence
 * that a user dismissed a window, and the constructor subscribes to it once so
 * the subscription cannot be forgotten by a caller.
 */
export interface ConsentWindowHost {
  /** Open the extension-origin window for this pending decision. Resolves with
   *  the browser's window id, or undefined if it created one without one. */
  open(pendingId: string): Promise<number | undefined>;
  close(windowId: number): Promise<void>;
  onRemoved(listener: (windowId: number) => void): void;
}

export interface ConsentWindowsOptions {
  host: ConsentWindowHost;
  log?: Logger;
  /** Overridable so a check can watch a deadline fire without waiting minutes.
   *  Production passes neither and gets the constants above. */
  askWindowMs?: number;
  approveWindowMs?: number;
}

interface PendingUi {
  id: string;
  payload: ConsentPayload;
  deferred: Deferred<unknown>;
  windowId?: number;
  /**
   * The session this window is asking on behalf of, when there is one.
   *
   * Only questions carry it, and only so a dying session can close its own
   * window. Without it the user goes on filling in a form whose agent stopped
   * listening — the form-shaped version of the stall this whole path exists to
   * avoid.
   */
  ref?: string;
  timer?: ReturnType<typeof setTimeout>;
}

export class ConsentWindows {
  readonly #host: ConsentWindowHost;
  readonly #log: Logger;
  readonly #askWindowMs: number;
  readonly #approveWindowMs: number;
  readonly #pending = new Map<string, PendingUi>();

  constructor(options: ConsentWindowsOptions) {
    this.#host = options.host;
    this.#log = options.log ?? createLogger('extension.consent');
    this.#askWindowMs = options.askWindowMs ?? ASK_WINDOW_MS;
    this.#approveWindowMs = options.approveWindowMs ?? APPROVE_WINDOW_MS;
    this.#host.onRemoved((windowId) => {
      for (const pending of [...this.#pending.values()]) {
        if (pending.windowId !== windowId) continue;
        // Closing the window without answering is a denial, never a default
        // grant.
        this.#settle(pending.id, consentDenial(pending.payload.kind));
      }
    });
  }

  /** The connect consent: verified origin, agent picker, tool list. Resolves
   *  with the chosen agent's pubkey, or null for a decline. */
  askConnect(origin: string, agents: AgentRow[], request: PageConnectRequest): Promise<string | null> {
    return this.#present({ kind: 'connect', origin, request, agents }).then((value) =>
      typeof value === 'string' ? value : null,
    );
  }

  askPair(agent: { name: string; runtime: string; location?: string }): Promise<boolean> {
    return this.#present({ kind: 'pair', agent }).then((value) => value === true);
  }

  /** A per-call approval in extension chrome. Never the page or OS chrome. */
  askApproval(
    origin: string,
    who: { name: string },
    prompt: { domain: AuthorityDomain; summary: string; call?: { name: string; arguments: Record<string, unknown> } },
    synthesised: ReadonlySet<string>,
  ): Promise<boolean> {
    // The extension stamps this one, because the extension is the only party
    // that knows. The client sees a tool in a grant and calls it `site_tool`;
    // it cannot tell a tool the SITE declared from one WE synthesised over a
    // page that declared nothing. Same rule as ADR-023 R2 — the side that knows
    // the truth decides — applied one hop further out.
    //
    // This is a DISPLAY correction, not a routing one. A generic page tool
    // routes exactly as a site tool does, because a page can already click its
    // own buttons; what was wrong is telling the user a site lent a capability
    // the site has never heard of.
    const domain: AuthorityDomain =
      prompt.domain === 'site_tool' && prompt.call && synthesised.has(prompt.call.name)
        ? 'generic_page_tool'
        : prompt.domain;
    return this.#present(
      {
        kind: 'approve',
        origin,
        agentName: who.name,
        domain,
        summary: prompt.summary,
        ...(prompt.call ? { call: prompt.call } : {}),
      },
      { deadlineMs: this.#approveWindowMs },
    ).then((value) => value === true);
  }

  /**
   * The agent asking its own user a question, in extension chrome (ADR-024 R12).
   *
   * The daemon grants this tier `mayAsk` because the CLIENT holds the user key —
   * and the client is this worker, not the document. So the question never
   * reaches page world at all: it opens the same extension-origin window every
   * approval uses, and only the answer travels back.
   *
   * Resolves the fields the user filled, or `undefined` for a SKIP. A skip is a
   * real answer meaning "proceed without one", which is why every failure path
   * here produces one rather than leaving the agent waiting.
   */
  askQuestion(
    ref: string,
    origin: string,
    who: { name: string },
    question: { message: string; fields: FormField[] },
  ): Promise<AnswerField[] | undefined> {
    return this.#present(
      { kind: 'ask', origin, agentName: who.name, message: question.message, fields: question.fields },
      { ref, deadlineMs: this.#askWindowMs },
    ).then((value) =>
      // Anything that is not a list of fields is a skip: the denial value, a
      // dismissed window, a worker that restarted. Never coerced into an answer.
      Array.isArray(value) ? (value as AnswerField[]) : undefined,
    );
  }

  /**
   * The session that opened these windows is gone; settle each as its own
   * kind's refusal, which also closes it.
   *
   * The registry's single door into this module. Only questions carry a `ref`
   * today, so only questions are reachable through it — an approval window is
   * bounded by its deadline instead.
   */
  closeFor(ref: string): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.ref === ref) this.#settle(pending.id, consentDenial(pending.payload.kind));
    }
  }

  /** The consent window connected: it fetches the payload it must render by id,
   *  and answers over this same port. Both directions are keyed by an id minted
   *  here, so a window cannot answer a decision it was not shown. */
  handlePort(port: chrome.runtime.Port): void {
    const reply = (message: WorkerToConsent) => {
      try {
        port.postMessage(message);
      } catch {
        // window already gone
      }
    };
    port.onMessage.addListener((raw: unknown) => {
      if (!isRecord(raw)) return;
      const message = raw as ConsentToWorker;
      if (message.t === 'consent.get') {
        const pending = typeof message.id === 'string' ? this.#pending.get(message.id) : undefined;
        if (pending) reply({ t: 'ok', rid: message.rid, value: pending.payload });
        else reply({ t: 'err', rid: message.rid, message: 'nothing to decide — this question was already answered' });
        return;
      }
      if (message.t === 'consent.answer' && typeof message.id === 'string') {
        this.#settle(message.id, message.value);
      }
    });
  }

  /**
   * Mint, register, arm and open — in that order, and in one place.
   *
   * The order is the fail-closed rule: the deadline is armed BEFORE the window
   * is asked for, so a browser that never opens one still ends in a refusal
   * rather than in a promise nobody settles.
   *
   * Only the two kinds whose far side has a deadline of its own carry one here.
   * A connect or pair window left open blocks nothing at the agent: the page's
   * own `connect()` is the only thing waiting, and it is waiting on a person.
   */
  #present(payload: ConsentPayload, options: { ref?: string; deadlineMs?: number } = {}): Promise<unknown> {
    const pending: PendingUi = {
      id: mintId('ui_'),
      payload,
      deferred: new Deferred<unknown>(),
      ...(options.ref === undefined ? {} : { ref: options.ref }),
    };
    this.#pending.set(pending.id, pending);
    if (options.deadlineMs !== undefined) {
      pending.timer = setTimeout(() => {
        if (!this.#pending.has(pending.id)) return;
        this.#log.warn('closing an unanswered consent window before the agent stops listening', {
          data: { pendingId: pending.id, kind: payload.kind, waitedMs: options.deadlineMs },
        });
        this.#settle(pending.id, consentDenial(payload.kind));
      }, options.deadlineMs);
    }
    this.#observe(this.#open(pending), 'consent window flow failed', {
      data: { pendingId: pending.id, kind: payload.kind },
    });
    return pending.deferred.promise;
  }

  async #open(pending: PendingUi): Promise<void> {
    try {
      pending.windowId = await this.#host.open(pending.id);
    } catch (err) {
      this.#log.error('could not open consent window; denying request', {
        err,
        data: { pendingId: pending.id, kind: pending.payload.kind },
      });
      // No window means no consent surface, and a missing answer is a denial.
      this.#settle(pending.id, consentDenial(pending.payload.kind));
    }
  }

  #settle(id: string, value: unknown): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    pending.deferred.resolve(value);
    if (pending.windowId !== undefined) {
      this.#observe(this.#host.close(pending.windowId), 'failed to close consent window', {
        data: { pendingId: id },
      });
    }
  }

  #observe(promise: PromiseLike<unknown> | undefined, message: string, context?: LogContext): void {
    if (!promise) return;
    void promise.then(undefined, (err: unknown) => this.#log.error(message, { ...context, err }));
  }
}
