import {
  EventType,
  type ActivitySnapshotEvent,
  type BaseEvent,
  type ReasoningEndEvent,
  type ReasoningMessageContentEvent,
  type ReasoningMessageEndEvent,
  type ReasoningMessageStartEvent,
  type ReasoningStartEvent,
  type RunErrorEvent,
  type RunFinishedEvent,
  type RunStartedEvent,
  type TextMessageContentEvent,
  type TextMessageEndEvent,
  type TextMessageStartEvent,
  type ToolCallArgsEvent,
  type ToolCallEndEvent,
  type ToolCallResultEvent,
  type ToolCallStartEvent,
} from '@ag-ui/core';
import type { AgentSessionHandle, SessionEvents } from '@agentport/client';
import type { PromptImage } from '@agentport/protocol';

/**
 * The event vocabulary comes from the spec's own package, not from a local
 * restatement of it. A copy drifts silently — the hand-rolled version of this
 * file missed TOOL_CALL_RESULT entirely, so renderers saw tool calls but never
 * their results.
 *
 * `@ag-ui/core` pulls in zod, which the bundle-size rules for
 * `@agentport/protocol` and `@agentport/client` would forbid. Those rules do
 * not reach here: the dependency direction is agui → client and never the
 * reverse, and `@agentport/agui` is consumed only by our own demo surfaces
 * (site/src/agentport-ui.ts, bundled into inkwell and tasker). It is NOT in
 * connect.js, the drop-in that ships into other people's pages.
 */
export { EventType } from '@ag-ui/core';
export type {
  ActivitySnapshotEvent,
  ReasoningEndEvent,
  ReasoningMessageContentEvent,
  ReasoningMessageEndEvent,
  ReasoningMessageStartEvent,
  ReasoningStartEvent,
  RunErrorEvent,
  RunFinishedEvent,
  RunStartedEvent,
  TextMessageContentEvent,
  TextMessageEndEvent,
  TextMessageStartEvent,
  ToolCallArgsEvent,
  ToolCallEndEvent,
  ToolCallResultEvent,
  ToolCallStartEvent,
} from '@ag-ui/core';

/**
 * CUSTOM is AG-UI's escape hatch. The spec types its `value` as `any`; these
 * two aliases pin the payloads AgentPort actually puts there so consumers keep
 * real types. Only the AgentPort-specific part is local — the base fields and
 * the discriminant still come from the spec.
 */
export type AgentPortApprovalEvent = BaseEvent & {
  type: EventType.CUSTOM;
  name: 'agentport.approval';
  value: SessionEvents['approval'];
};

export type AgentPortClosedEvent = BaseEvent & {
  type: EventType.CUSTOM;
  name: 'agentport.closed';
  value: SessionEvents['closed'];
};

/**
 * The socket dropped and the attachment was re-established underneath the
 * session. A renderer should say so: the sealing keys are new, so the
 * fingerprint words a careful user compared are new too.
 */
export type AgentPortReattachedEvent = BaseEvent & {
  type: EventType.CUSTOM;
  name: 'agentport.reattached';
  value: SessionEvents['reattached'];
};

/**
 * The agent is asking its own user a question, mid-turn (ADR-024).
 *
 * CUSTOM rather than a standard event because AG-UI has no elicitation in its
 * vocabulary: nothing in `EventType` carries a form back to the agent, and
 * inventing a TEXT_MESSAGE for it would render a question the user cannot
 * answer. A renderer that ignores this one is not merely missing a nicety —
 * the turn stalls until the daemon's ask deadline and then decays to a skip,
 * which is the bug that made this event exist.
 *
 * Answer it with `session.answer(value.id, …)`. Answering is the renderer's
 * job, not the adapter's: the adapter holds no consent surface, and a stream
 * translator that silently answered for the user would be forging exactly the
 * authority ADR-024 R11 protects.
 */
export type AgentPortAskEvent = BaseEvent & {
  type: EventType.CUSTOM;
  name: 'agentport.ask';
  value: SessionEvents['ask'];
};

/** The subset of the AG-UI event union this adapter can produce. */
export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | ActivitySnapshotEvent
  | AgentPortApprovalEvent
  | AgentPortAskEvent
  | AgentPortReattachedEvent
  | AgentPortClosedEvent;

export interface AguiAdapter {
  events: AsyncIterable<AguiEvent>;
  /** `blocks` (v7): images attached to this run, forwarded to the session. */
  run(text: string, blocks?: readonly PromptImage[]): Promise<string>;
  cancel(runId: string): boolean;
}

type Emit = (event: AguiEvent) => void;

interface PromptState {
  runId: string;
  external: boolean;
  text: string;
  textStarted: boolean;
  reasoningStarted: boolean;
}

interface PendingRun {
  runId: string;
  promptId?: string;
  settled: boolean;
}

/**
 * TOOL_CALL_RESULT carries a string. Tool results are hostile data (they can
 * come from a poisoned document), so serialization must degrade visibly rather
 * than throw and kill the event stream mid-run.
 */
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Cycles and BigInt make stringify throw; the coerced form still reaches
    // the renderer, so nothing is silently dropped.
    return String(value);
  }
}

class Translator {
  readonly #session: AgentSessionHandle;
  readonly #emit: Emit;
  readonly #finish: () => void;
  readonly #prompts = new Map<string, PromptState>();
  readonly #pendingRuns: PendingRun[] = [];
  readonly #off: Array<() => void>;
  #nextRun = 0;
  #nextTool = 0;
  #stopped = false;

  constructor(session: AgentSessionHandle, emit: Emit, finish: () => void) {
    this.#session = session;
    this.#emit = emit;
    this.#finish = finish;
    /**
     * One entry per member of `SessionEvents`, and the RECORD TYPE is what
     * makes that total: omit a member and this object stops compiling.
     *
     * It was an array literal, which is a registry the compiler cannot check
     * — and it was already wrong. `ask` was missing for its whole existence,
     * so the agent asked its user a question, `AgentSession` emitted it, and
     * this adapter translated it into nothing at all. The turn then blocked
     * for the daemon's five-minute ask deadline and decayed to a skip, with
     * no event, no log, and nothing on screen to explain the pause. Same
     * disease as the plain-`Set` in `messages.ts`: a handler set nobody could
     * prove complete.
     *
     * The entries are subscription FACTORIES rather than bare handlers so the
     * literal event name stays inside `session.on(...)`, where it types the
     * listener's argument — no cast, and the emitted value keeps its real
     * type all the way to the union.
     *
     * What this does NOT prove: that a key matches the name beside it. The
     * compiler checks that every member is PRESENT, not that `plan:` listens
     * to `'plan'`. That is a typo on one line, visible where it is made; the
     * failure this guard exists for is the one nobody can see, an event with
     * no line at all.
     */
    const subscriptions: Record<keyof SessionEvents, () => () => void> = {
      delta: () => session.on('delta', (event) => this.#onDelta(event)),
      thought: () => session.on('thought', (event) => this.#onThought(event)),
      ask: () =>
        session.on('ask', (event) => this.#emit({ type: EventType.CUSTOM, name: 'agentport.ask', value: event })),
      plan: () => session.on('plan', (event) => this.#onPlan(event)),
      reattached: () =>
        session.on('reattached', (event) =>
          this.#emit({ type: EventType.CUSTOM, name: 'agentport.reattached', value: event }),
        ),
      done: () => session.on('done', (event) => this.#onDone(event)),
      tool: () => session.on('tool', (event) => this.#onTool(event)),
      approval: () =>
        session.on('approval', (event) =>
          this.#emit({ type: EventType.CUSTOM, name: 'agentport.approval', value: event }),
        ),
      closed: () => session.on('closed', (event) => this.#onClosed(event)),
    };
    this.#off = Object.values(subscriptions).map((subscribe) => subscribe());
  }

  run(text: string, blocks?: readonly PromptImage[]): Promise<string> {
    const pending: PendingRun = { runId: this.#id('run', ++this.#nextRun), settled: false };
    this.#pendingRuns.push(pending);
    this.#emit({ type: EventType.RUN_STARTED, threadId: this.#session.id, runId: pending.runId });

    let result: Promise<string>;
    try {
      const request = this.#session.startPrompt(text, undefined, blocks);
      pending.promptId = request.id;
      result = request.result;
    } catch (error) {
      pending.settled = true;
      this.#removePending(pending);
      this.#emitRunError(pending.runId, error);
      return Promise.reject(error);
    }

    return result.then(
      (value) => {
        if (pending.settled) return value;
        pending.settled = true;
        this.#removePending(pending);
        this.#emit({
          type: EventType.RUN_FINISHED,
          threadId: this.#session.id,
          runId: pending.runId,
          result: value,
        });
        return value;
      },
      (error: unknown) => {
        if (pending.settled) return Promise.reject(error);
        pending.settled = true;
        this.#removePending(pending);
        this.#emitRunError(pending.runId, error);
        return Promise.reject(error);
      },
    );
  }

  cancel(runId: string): boolean {
    const pending = this.#pendingRuns.find((run) => run.runId === runId && !run.settled);
    if (!pending?.promptId) return false;
    this.#session.cancel(pending.promptId);
    return true;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    for (const off of this.#off) off();
  }

  #onDelta(event: SessionEvents['delta']): void {
    if (event.text.length === 0) return;
    const prompt = this.#prompt(event.promptId);
    if (!prompt.textStarted) {
      prompt.textStarted = true;
      this.#emit({ type: EventType.TEXT_MESSAGE_START, messageId: event.promptId, role: 'assistant' });
    }
    prompt.text += event.text;
    this.#emit({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: event.promptId, delta: event.text });
  }

  #onThought(event: SessionEvents['thought']): void {
    if (event.text.length === 0) return;
    const prompt = this.#prompt(event.promptId);
    const messageId = this.#reasoningId(event.promptId);
    if (!prompt.reasoningStarted) {
      prompt.reasoningStarted = true;
      this.#emit({ type: EventType.REASONING_START, messageId });
      this.#emit({ type: EventType.REASONING_MESSAGE_START, messageId, role: 'reasoning' });
    }
    this.#emit({ type: EventType.REASONING_MESSAGE_CONTENT, messageId, delta: event.text });
  }

  /**
   * A plan is an AG-UI activity, not a message: ACTIVITY_SNAPSHOT with
   * `replace: true` says exactly what our wire says — this is the whole plan
   * now, discard the previous one — so a standard renderer shows the agent's
   * progress with no AgentPort-specific code.
   */
  #onPlan(event: SessionEvents['plan']): void {
    this.#emit({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: this.#planId(event.promptId),
      activityType: 'plan',
      content: { steps: event.steps },
      replace: true,
    });
  }

  #onDone(event: SessionEvents['done']): void {
    const prompt = this.#prompt(event.promptId);
    this.#closePrompt(event.promptId, prompt);
    this.#prompts.delete(event.promptId);

    // Direct AgentSession.prompt() calls have no observable start hook, so
    // their first prompt-scoped event establishes a well-formed lazy run.
    if (prompt.external) {
      if (event.stopReason === 'error') {
        this.#emit({
          type: EventType.RUN_ERROR,
          message: event.error ?? 'agent error',
          code: 'AGENT_ERROR',
          rawEvent: { runId: prompt.runId, promptId: event.promptId, stopReason: event.stopReason },
        });
      } else {
        this.#emit({
          type: EventType.RUN_FINISHED,
          threadId: this.#session.id,
          runId: prompt.runId,
          result: prompt.text,
        });
      }
    }
  }

  #onTool(event: SessionEvents['tool']): void {
    const toolCallId = this.#id('tool', ++this.#nextTool);
    this.#emit({ type: EventType.TOOL_CALL_START, toolCallId, toolCallName: event.name });
    this.#emit({ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(event.arguments) });
    this.#emit({ type: EventType.TOOL_CALL_END, toolCallId });
    // TOOL_CALL_RESULT is where every AG-UI renderer looks for what a tool
    // returned, so the result belongs in `content` and nowhere else.
    // AgentSession reports the completed call without a wire message id, so the
    // result message is identified from the call. rawEvent still carries the
    // AgentPort event because the spec has no success/failure discriminator on
    // a tool result — a failed tool is a result, not a failed run.
    this.#emit({
      type: EventType.TOOL_CALL_RESULT,
      messageId: `${toolCallId}:result`,
      toolCallId,
      content: event.ok ? resultText(event.result) : (event.error ?? 'tool call failed'),
      role: 'tool',
      rawEvent: event,
    });
  }

  #onClosed(event: SessionEvents['closed']): void {
    for (const [promptId, prompt] of this.#prompts) {
      this.#closePrompt(promptId, prompt);
      if (prompt.external) this.#emitRunError(prompt.runId, new Error(`session closed: ${event.reason}`));
    }
    this.#prompts.clear();
    for (const pending of this.#pendingRuns) {
      if (pending.settled) continue;
      pending.settled = true;
      this.#emitRunError(pending.runId, new Error(`session closed: ${event.reason}`));
    }
    this.#pendingRuns.splice(0);
    this.#emit({ type: EventType.CUSTOM, name: 'agentport.closed', value: event });
    this.stop();
    this.#finish();
  }

  #prompt(promptId: string): PromptState {
    const existing = this.#prompts.get(promptId);
    if (existing) return existing;

    const pending =
      this.#pendingRuns.find((run) => run.promptId === promptId) ??
      this.#pendingRuns.find((run) => run.promptId === undefined);
    if (pending) {
      pending.promptId ??= promptId;
      const prompt: PromptState = {
        runId: pending.runId,
        external: false,
        text: '',
        textStarted: false,
        reasoningStarted: false,
      };
      this.#prompts.set(promptId, prompt);
      return prompt;
    }

    const prompt: PromptState = {
      runId: promptId,
      external: true,
      text: '',
      textStarted: false,
      reasoningStarted: false,
    };
    this.#prompts.set(promptId, prompt);
    this.#emit({ type: EventType.RUN_STARTED, threadId: this.#session.id, runId: prompt.runId });
    return prompt;
  }

  #removePending(pending: PendingRun): void {
    const index = this.#pendingRuns.indexOf(pending);
    if (index !== -1) this.#pendingRuns.splice(index, 1);
  }

  #closePrompt(promptId: string, prompt: PromptState): void {
    if (prompt.textStarted) this.#emit({ type: EventType.TEXT_MESSAGE_END, messageId: promptId });
    if (!prompt.reasoningStarted) return;
    const messageId = this.#reasoningId(promptId);
    this.#emit({ type: EventType.REASONING_MESSAGE_END, messageId });
    this.#emit({ type: EventType.REASONING_END, messageId });
  }

  #emitRunError(runId: string, error: unknown): void {
    this.#emit({
      type: EventType.RUN_ERROR,
      message: error instanceof Error ? error.message : String(error),
      code: 'AGENTPORT_RUN_ERROR',
      rawEvent: { runId },
    });
  }

  #reasoningId(promptId: string): string {
    return `${promptId}:reasoning`;
  }

  /** Stable per prompt, so each snapshot replaces the previous plan rather
   *  than stacking a new activity beside it. */
  #planId(promptId: string): string {
    return `${promptId}:plan`;
  }

  #id(kind: 'run' | 'tool', counter: number): string {
    return `${this.#session.id}:${kind}:${counter}`;
  }
}

class EventQueue implements AsyncIterableIterator<AguiEvent> {
  readonly #values: AguiEvent[] = [];
  readonly #waiters: Array<(value: IteratorResult<AguiEvent>) => void> = [];
  #done = false;
  #onReturn: (() => void) | undefined;

  [Symbol.asyncIterator](): AsyncIterableIterator<AguiEvent> {
    return this;
  }

  next(): Promise<IteratorResult<AguiEvent>> {
    const value = this.#values.shift();
    if (value) return Promise.resolve({ done: false, value });
    if (this.#done) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  return(): Promise<IteratorResult<AguiEvent>> {
    this.end();
    this.#onReturn?.();
    return Promise.resolve({ done: true, value: undefined });
  }

  push(event: AguiEvent): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ done: false, value: event });
    else this.#values.push(event);
  }

  end(): void {
    if (this.#done) return;
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  onReturn(callback: () => void): void {
    this.#onReturn = callback;
  }
}

/** Translate one live AgentPort attachment into an AG-UI-compatible event stream. */
export function aguiStream(session: AgentSessionHandle): AguiAdapter {
  const events = new EventQueue();
  const translator = new Translator(session, (event) => events.push(event), () => events.end());
  events.onReturn(() => translator.stop());
  return {
    events,
    run: (text) => translator.run(text),
    cancel: (runId) => translator.cancel(runId),
  };
}

/** Subscribe without a stream abstraction; returns a listener teardown function. */
export function onAguiEvent(session: AgentSessionHandle, callback: (event: AguiEvent) => void): () => void {
  const translator = new Translator(session, callback, () => undefined);
  return () => translator.stop();
}
