declare const __AGENTPORT_VERSION__: string | undefined;

/** Baked in by site/build.ts; 'dev' under tsx/test runners with no define. */
const VERSION = typeof __AGENTPORT_VERSION__ === 'string' ? __AGENTPORT_VERSION__ : 'dev';

/**
 * The demo's agent panel, rendered by the protocol-neutral Nisli chat set.
 *
 * Note what is no longer here: no key, no `AgentWallet`, no picker, no consent
 * screen. Those moved to where the user's key actually is — an extension, the
 * hosted wallet's own origin, or their terminal in the universal fallback.
 * This file is an honest example of what a *site* writes, and nothing more.
 *
 * The panel consumes the same AG-UI event stream a third-party renderer would,
 * then translates it once into the protocol-neutral semantic updates owned by
 * the chat store. Transport vocabulary stops at that boundary; the components
 * only know messages, reasoning, tools, and runs.
 *
 * Styling comes from the chat set's `data-slot` contract. The copied source
 * carries utility classes for projects that build them, but this demo keeps
 * its own small token-driven stylesheet and no Tailwind pipeline.
 *
 * This is our own page rather than an injected surface, so `component()` is
 * safe here; the injected modal deliberately avoids it (see modal.ts).
 */

import { component, computed, each, html, onCleanup, signal, when, type Signal } from '@nisli/core';
import AgentPortConnect from './connect.js';
import { aguiStream, type AguiAdapter, type AguiEvent } from '@agentport/agui';
import type { AgentSessionHandle, ApprovalPrompt, SessionEvents, SiteTool } from '@agentport/client';
import { toErr, type FormField, type HistoryEntry, type PlanStep } from '@agentport/protocol';
import { Chat, createChatStore, type ChatController } from '../../src/nisli-ui/ui/chat/index.js';
import { siteLogger } from './observe.js';

const log = siteLogger.child('panel');

export type { SiteTool };

export interface SurfaceConfig {
  name: string;
  route?: string;
  context?: Record<string, unknown>;
  tools: SiteTool[];
  alwaysAsk?: string[];
  placeholder?: string;
  suggestions?: string[];
  /**
   * Receives the panel's API once it exists, so the page can send prompts it
   * composed itself (e.g. inkwell's annotations). The prompt enters the same
   * busy-aware queue as composer input. Returns false when unavailable.
   */
  bind?: (panel: PanelApi) => void;
}

export interface PanelApi {
  send(text: string): boolean;
  get live(): boolean;
}

const text = (value: string) => ({ type: 'text' as const, text: value });

/**
 * The status line's name for the attached agent. Since v7 a page tier is not
 * told the runtime at all — absence is the ordinary case here, not a gap —
 * so the label is the name alone unless this surface is the user's own key.
 */
function agentLabel(info: AgentSessionHandle['info']): string {
  return info.runtime ? `${info.agentName} · ${info.runtime}` : info.agentName;
}

function displayJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}


const AgentPanel = component<{ config: SurfaceConfig }>('agent-panel', (props) => {
  // nisli props are signals — `props.config` is Signal<SurfaceConfig>, not the
  // object. Casting instead of reading `.value` silently yields undefined
  // fields, which is exactly how the connect button died quietly once already.
  const config = props.config.value;

  const chat = createChatStore();
  const status = signal('not connected');
  const online = signal(false);
  const live = signal(false);
  const busy = signal(false);
  const notice = signal('');
  // The agent's current plan, replaced wholesale by each snapshot. Not part of
  // the transcript: a plan is what the agent intends *now*, and replaying every
  // revision would read as repetition rather than as the conversation.
  const plan = signal<PlanStep[]>([]);
  // Fingerprint words for the CURRENT attachment. Kept as state rather than a
  // transient message: they change on every reconnect, and the run error that
  // a dropped turn produces would otherwise overwrite the only notice showing
  // them — losing the one check a careful user can actually perform.
  const verify = signal('');
  // Persistent attachment state, exactly like `verify`, and for the same
  // reason: this is a standing fact about what the agent may do here, not a
  // transient message a later run error may overwrite.
  //
  // The daemon decides it and signs it into the sealing proof; the panel only
  // renders it. It has to be RENDERED and not merely carried: an agent that
  // silently cannot use half of itself is the invisible diminishment ADR-024
  // R4 names — the model experiences an absent affordance as nothing at all
  // and simply guesses, so the only party who can act on this is the user.
  //
  // Starts and resets FALSE. Nothing renders it until an attachment is live,
  // and the only thing that clears it is an attachment that positively said
  // its agent keeps its own tools — so the failure mode of a future edit is a
  // banner shown too often, not a restriction hidden.
  const ownTools = signal(false);

  let session: AgentSessionHandle | null = null;
  let adapter: AguiAdapter | null = null;
  let eventIterator: AsyncIterator<AguiEvent> | null = null;
  let chatController: ChatController | null = null;
  let toolSeq = 0;
  let currentRunId: string | null = null;
  let attachmentEpoch = 0;
  let disposed = false;
  let approvalCardSeq = 0;
  let askCardSeq = 0;

  // PROVENANCE. The site stores no transcript at all — not in localStorage,
  // not in sessionStorage, nowhere. On reload the panel re-attaches to the
  // session and asks the AGENT for the conversation, which lives in the
  // user's own agent session store on their own machine. The relay stores
  // none of it either.

  /**
   * The panel consumes the session through @agentport/agui (ADR-017) — the
   * same event stream any third-party AG-UI renderer would get, so the demo
   * itself proves the adapter. The switch below is the only protocol boundary
   * in the view: it produces semantic chat updates and never leaks wire event
   * names into the reusable components. Extension approvals arrive already
   * decided in trusted browser chrome; hosted-wallet delegations route
   * approvals to this page, so the decider below renders a real card and the
   * resulting event becomes the settled row.
   */
  const applyEvent = (event: AguiEvent): void => {
    switch (event.type) {
        case 'RUN_STARTED':
          chat.apply({ type: 'run.start' });
          busy.value = true;
          notice.value = '';
          currentRunId = event.runId;
          return;
        case 'TEXT_MESSAGE_START':
          chat.apply({ type: 'message.start', id: event.messageId, role: 'assistant' });
          return;
        case 'TEXT_MESSAGE_CONTENT':
          chat.apply({ type: 'message.delta', id: event.messageId, content: text(event.delta) });
          return;
        case 'TEXT_MESSAGE_END':
          chat.apply({ type: 'message.end', id: event.messageId });
          return;
        case 'REASONING_START':
          chat.apply({ type: 'reasoning.start', id: event.messageId });
          return;
        case 'REASONING_MESSAGE_CONTENT':
          chat.apply({ type: 'reasoning.delta', id: event.messageId, content: text(event.delta) });
          return;
        case 'REASONING_END':
          chat.apply({ type: 'reasoning.end', id: event.messageId });
          return;
        case 'TOOL_CALL_START':
          chat.apply({ type: 'tool.start', id: event.toolCallId, name: event.toolCallName });
          return;
        case 'TOOL_CALL_ARGS':
          chat.apply({ type: 'tool.input', id: event.toolCallId, input: event.delta });
          return;
        case 'TOOL_CALL_END':
          // The call is settled here; what it returned arrives next, exactly as
          // a third-party AG-UI renderer would see it.
          chat.apply({ type: 'tool.end', id: event.toolCallId });
          return;
        case 'TOOL_CALL_RESULT': {
          // `content` is the spec field every renderer reads. rawEvent carries
          // the AgentPort outcome because AG-UI has no success flag on a result.
          const call = event.rawEvent as SessionEvents['tool'];
          chat.apply({
            type: 'tool.end',
            id: event.toolCallId,
            status: call.ok ? 'complete' : 'error',
            output: event.content === '' ? undefined : [text(event.content)],
            error: call.ok ? undefined : (call.error ?? 'Tool call failed'),
          });
          return;
        }
        case 'ACTIVITY_SNAPSHOT':
          // AG-UI's standard activity event; `replace` is what makes a plan a
          // live checklist rather than an append-only log.
          if (event.activityType === 'plan') {
            const steps = (event.content as { steps?: PlanStep[] }).steps;
            plan.value = Array.isArray(steps) ? steps : [];
          }
          return;
        case 'RUN_FINISHED':
          chat.apply({ type: 'run.end' });
          currentRunId = null;
          busy.value = false;
          // A plan is what the agent intends NOW, so it dies with the turn.
          // Keeping a finished checklist would be readable but not truthful:
          // a cancelled or failed turn leaves steps sitting at active/pending
          // forever, advertising intent the agent no longer holds, and a next
          // turn that reports no plan would inherit the previous one.
          plan.value = [];
          return;
        case 'RUN_ERROR':
          chat.apply({ type: 'run.error', error: event.message });
          currentRunId = null;
          busy.value = false;
          plan.value = [];
          notice.value = event.message;
          return;
        case 'CUSTOM':
          if (event.name === 'agentport.approval') {
            const approval = event.value;
            const id = `approval-${toolSeq++}`;
            chat.apply({
              type: 'tool.start',
              id,
              name: approval.summary,
              input: approval.call?.arguments === undefined
                ? undefined
                : displayJson(approval.call.arguments),
            });
            chat.apply({ type: 'tool.end', id, status: approval.granted ? 'complete' : 'cancelled' });
          } else if (event.name === 'agentport.ask') {
            // WHICH TIERS CAN REACH THIS — because rendering is not
            // reachability, and reading it as such is how the next person
            // concludes the drop-in tier asks questions.
            //
            // Not the three tiers `connect.js` can take, today. The daemon
            // declares the elicitation capability only for an attachment with
            // NO delegation, and then routes the connect tier's questions to
            // its own terminal (ADR-024 R11/R12). So: the hosted wallet's
            // delegated attachment is refused the capability outright, the
            // connect-code tier keeps its questions at the terminal, and the
            // extension tier deliberately leaves `ask` off the service
            // worker's forwarding list and refuses an answer composed in page
            // world.
            //
            // What DOES arrive here is a DIRECT-KEY attachment — a client
            // that holds the user key, which is `examples/inkwell` and any
            // embedder building its own `AgentWallet` around this panel. The
            // card below is that surface, and it is the same panel the day a
            // tier changes; a question with nobody listening is a five-minute
            // stall and a silent skip, which is the failure this exists for.
            pendingAsks.value = [
              ...pendingAsks.value,
              { id: ++askCardSeq, question: event.value, picked: signal(new Map<string, string[]>()) },
            ];
          } else if (event.name === 'agentport.reattached') {
            // Say it out loud. The connection dropped and came back on FRESH
            // sealing keys, so anyone who compared fingerprint words has new
            // ones to compare — a silent rekey would quietly invalidate the
            // only check the user can actually perform.
            verify.value = event.value.verify ?? '';
            notice.value = 'reconnected · new sealing keys';
            status.value = session ? agentLabel(session.info) : status.value;
            // Re-read rather than remembered: a re-attachment restates the
            // policy, and the panel keeps nothing across the gap.
            ownTools.value = session?.info.ownTools === true;
            online.value = true;
            // An in-flight turn lost its answer when the socket died; the
            // composer must not stay disabled waiting for a `done` that can
            // never arrive.
            busy.value = false;
            currentRunId = null;
            plan.value = [];
            chat.apply({ type: 'run.end' });
          } else if (event.name === 'agentport.closed') {
            for (const approval of pendingApprovals.value) approval.resolve(false);
            pendingApprovals.value = [];
            // A question outlives nothing: there is no channel to answer into,
            // and the daemon tore its own side down with the session.
            pendingAsks.value = [];
            notice.value = `session closed (${event.value.reason})`;
            status.value = 'disconnected';
            online.value = false;
            live.value = false;
            busy.value = false;
            session = null;
            adapter = null;
            currentRunId = null;
            plan.value = [];
            verify.value = '';
            ownTools.value = false;
            chat.reset();
          }
          return;
        default:
          return;
    }
  };

  const consume = async (events: AsyncIterator<AguiEvent>): Promise<void> => {
    try {
      while (true) {
        const next = await events.next();
        if (next.done || eventIterator !== events) return;
        applyEvent(next.value);
      }
    } catch (error) {
      if (eventIterator !== events) return;
      const message = error instanceof Error ? error.message : String(error);
      chat.apply({ type: 'run.error', error: message });
      busy.value = false;
      notice.value = `event stream failed: ${message}`;
    }
  };

  interface PendingApproval {
    id: number;
    prompt: ApprovalPrompt;
    resolve: (granted: boolean) => void;
  }
  const pendingApprovals = signal<PendingApproval[]>([]);

  /** Delegated sessions route approvals here; the card IS the consent UI. */
  const decide = (prompt: ApprovalPrompt): Promise<boolean> =>
    new Promise((resolve) => {
      pendingApprovals.value = [...pendingApprovals.value, { id: ++approvalCardSeq, prompt, resolve }];
    });

  const settleApproval = (id: number, granted: boolean) => {
    const approval = pendingApprovals.value.find((candidate) => candidate.id === id);
    if (!approval) return;
    pendingApprovals.value = pendingApprovals.value.filter((candidate) => candidate.id !== id);
    approval.resolve(granted);
  };

  /**
   * A question the agent asked its user (ADR-024), waiting for an answer.
   *
   * Per-card state lives in its OWN signal rather than in the array, so typing
   * an answer does not rebuild every other card, and the array only changes
   * when a question arrives or settles.
   */
  interface PendingAsk {
    id: number;
    question: SessionEvents['ask'];
    /**
     * Field key → chosen values. A Map, not an object, because these keys came
     * over the wire and `__proto__` is legal by the id pattern — a Map has no
     * prototype chain to walk into. This is the same rule the extension's
     * question window uses (`packages/extension/src/consent.ts`), deliberately:
     * two surfaces drawing one protocol shape must not disagree about what an
     * answer is.
     */
    picked: Signal<Map<string, string[]>>;
  }
  const pendingAsks = signal<PendingAsk[]>([]);

  const pickedFor = (ask: PendingAsk, key: string): string[] => ask.picked.value.get(key) ?? [];

  const setPicked = (ask: PendingAsk, key: string, values: string[]): void => {
    ask.picked.value = new Map(ask.picked.value).set(
      key,
      values.filter((value) => value !== ''),
    );
  };

  const toggleOption = (ask: PendingAsk, field: FormField, option: string): void => {
    const current = pickedFor(ask, field.key);
    if (field.multi) {
      setPicked(ask, field.key, current.includes(option) ? current.filter((value) => value !== option) : [...current, option]);
      return;
    }
    // Tapping the chosen option again clears it. The user has to be able to get
    // back to "I did not answer this", which is not the same as any option.
    setPicked(ask, field.key, current[0] === option ? [] : [option]);
  };

  /**
   * The Map as `session.answer()` wants it: one string per field, several
   * choices joined, and an empty field omitted entirely — omitting every field
   * is what makes the answer a SKIP, which is a real outcome and not an error.
   *
   * `Object.fromEntries`, not an object literal with assignment: assigning to
   * `__proto__` on an ordinary object invokes the setter instead of creating
   * the property, so a field legitimately keyed `__proto__` would be silently
   * dropped from the answer the user gave.
   */
  const answersFrom = (picked: ReadonlyMap<string, readonly string[]>): Record<string, string> =>
    Object.fromEntries(
      [...picked.entries()]
        .map(([key, values]) => [key, values.filter((value) => value !== '').join(', ')] as const)
        .filter(([, value]) => value !== ''),
    ) as Record<string, string>;

  /** What the transcript records once a question is behind us. */
  const answerSummary = (ask: PendingAsk, answers: Record<string, string>): string =>
    ask.question.fields
      .filter((field) => answers[field.key] !== undefined)
      .map((field) => `${field.label}: ${answers[field.key] ?? ''}`)
      .join('\n');

  const settleAsk = (ask: PendingAsk, answers: Record<string, string>): void => {
    if (!pendingAsks.value.includes(ask)) return;
    pendingAsks.value = pendingAsks.value.filter((candidate) => candidate !== ask);
    const answered = Object.keys(answers).length > 0;
    // The question and its outcome belong in the conversation, not only in a
    // card that disappears: the agent's next turn was steered by this, and a
    // user re-reading the transcript has to be able to see what they said.
    const rowId = `ask-${toolSeq++}`;
    chat.apply({ type: 'tool.start', id: rowId, name: 'Question from your agent', input: ask.question.message });
    chat.apply({
      type: 'tool.end',
      id: rowId,
      status: answered ? 'complete' : 'cancelled',
      output: answered ? [text(answerSummary(ask, answers))] : [text('Skipped — the agent continues without an answer.')],
    });
    if (!session) {
      // Nothing to answer into. Said out loud rather than swallowed: the agent
      // is waiting on the far side and its turn will decay to a skip.
      log.warn('a question was answered after the session ended', { data: { surface: config.name } });
      notice.value = 'the session ended before your answer could be sent';
      return;
    }
    try {
      // `answer` with no values IS the skip; there is no second verb for it.
      session.answer(ask.question.id, answered ? answers : undefined);
    } catch (err) {
      log.error('could not send the answer', { sessionId: session.id, err, data: { surface: config.name } });
      notice.value = `could not send your answer: ${toErr(err).message}`;
    }
  };

  const detachEvents = (): void => {
    const previous = eventIterator;
    eventIterator = null;
    adapter = null;
    void previous?.return?.();
    // A dead attachment must not leave a consent question hanging: unanswered
    // approvals fail closed.
    for (const approval of pendingApprovals.value) approval.resolve(false);
    pendingApprovals.value = [];
    // An agent's question dies with the attachment too — but silently, because
    // unlike an approval it has no "no" to fail closed to: the answer would go
    // into a channel that no longer exists.
    pendingAsks.value = [];
  };

  const attach = (next: AgentSessionHandle): void => {
    detachEvents();
    chat.reset();
    plan.value = [];
    toolSeq = 0;
    currentRunId = null;
    busy.value = false;
    session = next;
    adapter = aguiStream(next);
    eventIterator = adapter.events[Symbol.asyncIterator]();
    live.value = true;
    online.value = true;
    verify.value = next.info.verify ?? '';
    // `=== true`, fail-closed: an attachment that did not positively say its
    // agent keeps its own tools is one whose agent does not.
    ownTools.value = next.info.ownTools === true;
    status.value = agentLabel(next.info);
    notice.value = `connected · ${next.grant.tools.length} tools lent · expires ${new Date(
      next.grant.expiresAt,
    ).toLocaleTimeString()}`;
    void consume(eventIterator);
  };

  /** Replay the agent's own history through the reducer, one settled entry each. */
  const seed = (history: HistoryEntry[]) => {
    chat.reset();
    plan.value = [];
    for (const entry of history) {
      switch (entry.role) {
        case 'user':
          chat.addUserMessage(entry.text);
          break;
        case 'agent':
          {
            const id = `history-${toolSeq++}`;
            chat.apply({ type: 'message.start', id, role: 'assistant' });
            chat.apply({ type: 'message.delta', id, content: text(entry.text) });
            chat.apply({ type: 'message.end', id });
          }
          break;
        case 'thought':
          {
            const id = `history-${toolSeq++}`;
            chat.apply({ type: 'reasoning.start', id });
            chat.apply({ type: 'reasoning.delta', id, content: text(entry.text) });
            chat.apply({ type: 'reasoning.end', id });
          }
          break;
        default:
          {
            // Tool / approval history rows arrive as flat text.
            const id = `history-${toolSeq++}`;
            chat.apply({ type: 'tool.start', id, name: entry.text });
            chat.apply({ type: 'tool.end', id, status: 'complete' });
          }
      }
    }
    chat.apply({ type: 'run.end' });
  };

  /**
   * A refresh should not throw away a live agent. Re-attach and hydrate from
   * the agent before exposing the session; if it is gone, fall back to the
   * ordinary Connect button.
   */
  const restore = async () => {
    const attempt = ++attachmentEpoch;
    let resumedSession: AgentSessionHandle | null = null;
    try {
      const resumed = await AgentPortConnect.resume({
        name: config.name,
        route: config.route,
        context: config.context,
        tools: config.tools,
        alwaysAsk: config.alwaysAsk,
        decide,
      });
      if (!resumed) return;
      resumedSession = resumed.session;

      // Hydrate from the agent's own store rather than from anything we kept.
      const history = await resumedSession.history();
      if (disposed || attempt !== attachmentEpoch) {
        resumedSession.close('superseded');
        return;
      }
      attach(resumedSession);
      seed(history);
      notice.value = `reconnected · ${history.length} message(s) restored from your agent`;
    } catch (err) {
      resumedSession?.close('resume_failed');
      if (attempt !== attachmentEpoch) return;
      log.error('resume failed', { err, data: { surface: config.name } });
      notice.value = `could not reconnect: ${toErr(err).message}`;
    }
  };
  void restore();

  const connect = () => {
    const attempt = ++attachmentEpoch;
    // [SURFACE] The entire integration. An installed wallet is used if present;
    // otherwise the hosted wallet delegates, with the code flow as fallback.
    AgentPortConnect.connect({
      name: config.name,
      route: config.route,
      context: config.context,
      tools: config.tools,
      alwaysAsk: config.alwaysAsk,
      decide,
    })
      .then((next) => {
        if (disposed || attempt !== attachmentEpoch) {
          next.close('superseded');
          return;
        }
        attach(next);
      })
      .catch((err: Error) => {
        if (attempt !== attachmentEpoch) return;
        // A user dismissing the dialog is not an error. Anything else is, and
        // it goes both on screen and to the console — the previous version put
        // it in a hidden element, which is how a thrown TypeError looked
        // exactly like the button doing nothing.
        if (/cancelled/i.test(err.message)) return;
        log.error('connect failed', { err, data: { surface: config.name } });
        notice.value = `connect failed: ${err.message}`;
      });
  };

  onCleanup(() => {
    disposed = true;
    attachmentEpoch += 1;
    detachEvents();
    chatController = null;
  });

  const onPrompt = (prompt: string): boolean => {
    if (!session || !adapter || busy.value) return false;
    chat.addUserMessage(prompt);
    busy.value = true;
    // The AG-UI adapter owns run lifecycle events, including failures.
    adapter.run(prompt).catch((err: Error) => {
      log.error('prompt failed', { sessionId: session?.id, err, data: { surface: config.name } });
    });
    return true;
  };

  config.bind?.({
    send: (prompt) => live.value && chatController?.send(prompt) === true,
    get live() {
      return live.value;
    },
  });

  const onCancel = () => {
    if (adapter && currentRunId) adapter.cancel(currentRunId);
  };

  const empty = 'Ask your agent something.';

  return html`
    <div class="ap-head">
      <span>Agent <span class="ap-version" title="AgentPort build">v${VERSION}</span></span
      ><span class="ap-status" class:online=${online}>${status}</span>
    </div>
    ${when(
      computed(() => verify.value !== ''),
      () => html`<div class="ap-verify" title="Compare these words with your agent's consent screen">
        verify <code>${verify}</code>
      </div>`,
    )}

    ${when(
      computed(() => live.value && !ownTools.value),
      () => html`<div class="ap-limits" role="status">
        On this site your agent works with <strong>this site's tools only</strong> — its own tools
        stay on your machine, because nothing here can ask you about them without the site watching.
      </div>`,
    )}

    ${when(
      computed(() => !live.value),
      () => html`
        <div class="ap-empty">
          <p class="ap-pitch">
            Bring your own agent.<br />This site never sees your model, keys, or memory.
          </p>
          <button class="ap-connect" @click=${connect}>Connect agent</button>
          <p class="ap-alt">No install. Approve in your wallet popup, or use a connect code.</p>
        </div>
      `,
    )}

    <div class="ap-chat" class:live=${live}>
      ${when(
        computed(() => notice.value !== ''),
        () => html`<div class="ap-notice">${notice}</div>`,
      )}
      ${when(
        computed(() => plan.value.length > 0),
        () => html`<section class="ap-plan" aria-label="Agent plan">
          <div class="ap-plan-label">Plan</div>
          <ol>
            ${each(
              plan,
              (step, index) => `${index}:${step.text}`,
              (step) => {
                const status = computed(() => step.value.status);
                const mark = computed(() =>
                  step.value.status === 'done' ? '✓' : step.value.status === 'active' ? '▸' : '○',
                );
                return html`<li class="ap-plan-step" data-status=${status}>
                  <span class="ap-plan-mark" aria-hidden="true">${mark}</span>
                  <span>${computed(() => step.value.text)}</span>
                </li>`;
              },
            )}
          </ol>
        </section>`,
      )}
      ${each(
        pendingApprovals,
        (approval) => approval.id,
        (approval) => {
          const summary = computed(() => approval.value.prompt.summary);
          const toolName = computed(() => approval.value.prompt.call?.name ?? 'Agent request');
          const hasArguments = computed(() => approval.value.prompt.call !== undefined);
          const argumentsText = computed(() => JSON.stringify(approval.value.prompt.call?.arguments ?? {}, null, 2));
          // Which authority, in words, ABOVE the agent's own text (ADR-023
          // R4). `summary` is authored by the agent and steered by whatever
          // it has been reading, so it can be made to read like one of this
          // site's own tools; this line is the only part of the card the
          // agent does not write.
          //
          // Exhaustive, and matching the extension's consent window rather
          // than diverging from it. As a two-branch ternary the ELSE was
          // "your agent's own tool", so `generic_page_tool` — a tool the
          // extension synthesised over a page that declared nothing — would
          // have been described here as the user's own machine. That domain
          // cannot reach this panel today, since only the extension stamps
          // it, but "cannot reach it today" is how the other five of these
          // were introduced.
          const authority = computed(() => {
            switch (approval.value.prompt.domain) {
              case 'site_tool':
                return 'A tool this site lent your agent';
              case 'generic_page_tool':
                return 'A tool your extension built for this page';
              case 'runtime_own_tool':
                return "Your agent's own tool, on your machine";
              default: {
                const unhandled: never = approval.value.prompt.domain;
                return 'An authority this panel cannot name — decline unless you know why it is here';
              }
            }
          });
          return html`<section class="ap-approval" aria-live="polite">
            <div class="ap-approval-label">${authority}</div>
            <strong>${summary}</strong>
            <span class="ap-approval-tool">${toolName}</span>
            ${when(hasArguments, () => html`<pre>${argumentsText}</pre>`)}
            <div class="ap-approval-actions">
              <button class="deny" @click=${() => settleApproval(approval.value.id, false)}>Deny</button>
              <button @click=${() => settleApproval(approval.value.id, true)}>Allow</button>
            </div>
          </section>`;
        },
      )}
      ${each(
        pendingAsks,
        (ask) => ask.id,
        (ask) => {
          const message = computed(() => ask.value.question.message);
          const fields = computed(() => ask.value.question.fields);
          return html`<section data-slot="chat-ask" aria-live="polite">
            <div data-slot="chat-ask-label">Your agent is asking you</div>
            <p data-slot="chat-ask-message">${message}</p>
            ${each(
              fields,
              (field) => field.key,
              (field) => {
                const label = computed(() => field.value.label);
                const options = computed(() => field.value.options ?? []);
                // Two field kinds and nothing else: the wire shape is closed
                // (`FormField`), so a renderer that draws both draws every
                // question that can arrive.
                return html`<div data-slot="chat-ask-field">
                  <span data-slot="chat-ask-field-label">${label}</span>
                  ${when(
                    computed(() => options.value.length === 0),
                    () => html`<input
                      data-slot="chat-ask-input"
                      type="text"
                      placeholder="Leave blank to skip"
                      @input=${(event: Event) =>
                        setPicked(ask.value, field.value.key, [(event.target as HTMLInputElement).value])}
                    />`,
                  )}
                  ${when(
                    computed(() => options.value.length > 0),
                    () => html`<div data-slot="chat-ask-options">
                      ${each(
                        options,
                        (option) => option,
                        (option) => {
                          const selected = computed(() =>
                            pickedFor(ask.value, field.value.key).includes(option.value) ? 'true' : 'false',
                          );
                          return html`<button
                            data-slot="chat-ask-option"
                            type="button"
                            aria-selected=${selected}
                            @click=${() => toggleOption(ask.value, field.value, option.value)}
                          >
                            ${computed(() => option.value)}
                          </button>`;
                        },
                      )}
                    </div>`,
                  )}
                </div>`;
              },
            )}
            <p data-slot="chat-ask-hint">
              Skipping answers nothing and lets your agent carry on without one. It is never read as approval.
            </p>
            <div data-slot="chat-ask-actions">
              <button data-slot="chat-ask-skip" @click=${() => settleAsk(ask.value, {})}>Skip</button>
              <button
                data-slot="chat-ask-send"
                @click=${() => settleAsk(ask.value, answersFrom(ask.value.picked.value))}
              >
                Send answer
              </button>
            </div>
          </section>`;
        },
      )}
      ${Chat({
        entries: chat.entries,
        onPrompt,
        onCancel,
        busy,
        empty,
        suggestions: config.suggestions,
        bind: (controller) => {
          chatController = controller;
        },
        placeholder: config.placeholder ?? 'Ask your agent…',
      })}
    </div>
  `;
});

export function mountPanel(mount: HTMLElement, config: SurfaceConfig): void {
  html`${AgentPanel({ config })}`.mount(mount);
}
