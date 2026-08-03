import type { AgentSession, SessionEvents } from '@agentport/client';

interface BaseEvent {
  timestamp?: number;
  rawEvent?: unknown;
}

export type RunStartedEvent = BaseEvent & {
  type: 'RUN_STARTED';
  threadId: string;
  runId: string;
};

export type RunFinishedEvent = BaseEvent & {
  type: 'RUN_FINISHED';
  threadId: string;
  runId: string;
  result?: unknown;
};

export type RunErrorEvent = BaseEvent & {
  type: 'RUN_ERROR';
  message: string;
  code?: string;
};

export type TextMessageStartEvent = BaseEvent & {
  type: 'TEXT_MESSAGE_START';
  messageId: string;
  role: 'assistant';
};

export type TextMessageContentEvent = BaseEvent & {
  type: 'TEXT_MESSAGE_CONTENT';
  messageId: string;
  delta: string;
};

export type TextMessageEndEvent = BaseEvent & {
  type: 'TEXT_MESSAGE_END';
  messageId: string;
};

export type ToolCallStartEvent = BaseEvent & {
  type: 'TOOL_CALL_START';
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
};

export type ToolCallArgsEvent = BaseEvent & {
  type: 'TOOL_CALL_ARGS';
  toolCallId: string;
  delta: string;
};

export type ToolCallEndEvent = BaseEvent & {
  type: 'TOOL_CALL_END';
  toolCallId: string;
};

export type ReasoningStartEvent = BaseEvent & {
  type: 'REASONING_START';
  messageId: string;
};

export type ReasoningMessageStartEvent = BaseEvent & {
  type: 'REASONING_MESSAGE_START';
  messageId: string;
  role: 'reasoning';
};

export type ReasoningMessageContentEvent = BaseEvent & {
  type: 'REASONING_MESSAGE_CONTENT';
  messageId: string;
  delta: string;
};

export type ReasoningMessageEndEvent = BaseEvent & {
  type: 'REASONING_MESSAGE_END';
  messageId: string;
};

export type ReasoningEndEvent = BaseEvent & {
  type: 'REASONING_END';
  messageId: string;
};

export type AgentPortApprovalEvent = BaseEvent & {
  type: 'CUSTOM';
  name: 'agentport.approval';
  value: SessionEvents['approval'];
};

export type AgentPortClosedEvent = BaseEvent & {
  type: 'CUSTOM';
  name: 'agentport.closed';
  value: SessionEvents['closed'];
};

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
  | ReasoningStartEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ReasoningEndEvent
  | AgentPortApprovalEvent
  | AgentPortClosedEvent;

export interface AguiAdapter {
  events: AsyncIterable<AguiEvent>;
  run(text: string): Promise<string>;
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

class Translator {
  readonly #session: AgentSession;
  readonly #emit: Emit;
  readonly #finish: () => void;
  readonly #prompts = new Map<string, PromptState>();
  readonly #pendingRuns: PendingRun[] = [];
  readonly #off: Array<() => void>;
  #nextRun = 0;
  #nextTool = 0;
  #stopped = false;

  constructor(session: AgentSession, emit: Emit, finish: () => void) {
    this.#session = session;
    this.#emit = emit;
    this.#finish = finish;
    this.#off = [
      session.on('delta', (event: SessionEvents['delta']) => this.#onDelta(event)),
      session.on('thought', (event: SessionEvents['thought']) => this.#onThought(event)),
      session.on('done', (event: SessionEvents['done']) => this.#onDone(event)),
      session.on('tool', (event: SessionEvents['tool']) => this.#onTool(event)),
      session.on('approval', (event: SessionEvents['approval']) =>
        this.#emit({ type: 'CUSTOM', name: 'agentport.approval', value: event }),
      ),
      session.on('closed', (event: SessionEvents['closed']) => this.#onClosed(event)),
    ];
  }

  run(text: string): Promise<string> {
    const pending: PendingRun = { runId: this.#id('run', ++this.#nextRun), settled: false };
    this.#pendingRuns.push(pending);
    this.#emit({ type: 'RUN_STARTED', threadId: this.#session.id, runId: pending.runId });

    let result: Promise<string>;
    try {
      result = this.#session.prompt(text);
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
          type: 'RUN_FINISHED',
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
      this.#emit({ type: 'TEXT_MESSAGE_START', messageId: event.promptId, role: 'assistant' });
    }
    prompt.text += event.text;
    this.#emit({ type: 'TEXT_MESSAGE_CONTENT', messageId: event.promptId, delta: event.text });
  }

  #onThought(event: SessionEvents['thought']): void {
    if (event.text.length === 0) return;
    const prompt = this.#prompt(event.promptId);
    const messageId = this.#reasoningId(event.promptId);
    if (!prompt.reasoningStarted) {
      prompt.reasoningStarted = true;
      this.#emit({ type: 'REASONING_START', messageId });
      this.#emit({ type: 'REASONING_MESSAGE_START', messageId, role: 'reasoning' });
    }
    this.#emit({ type: 'REASONING_MESSAGE_CONTENT', messageId, delta: event.text });
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
          type: 'RUN_ERROR',
          message: event.error ?? 'agent error',
          code: 'AGENT_ERROR',
          rawEvent: { runId: prompt.runId, promptId: event.promptId, stopReason: event.stopReason },
        });
      } else {
        this.#emit({
          type: 'RUN_FINISHED',
          threadId: this.#session.id,
          runId: prompt.runId,
          result: prompt.text,
        });
      }
    }
  }

  #onTool(event: SessionEvents['tool']): void {
    const toolCallId = this.#id('tool', ++this.#nextTool);
    this.#emit({ type: 'TOOL_CALL_START', toolCallId, toolCallName: event.name });
    this.#emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(event.arguments) });
    // AgentSession exposes the completed call but not its wire id. rawEvent is
    // the AG-UI escape hatch that preserves the result without inventing an
    // incompatible field on TOOL_CALL_END or turning a tool failure into a run failure.
    this.#emit({ type: 'TOOL_CALL_END', toolCallId, rawEvent: event });
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
    this.#emit({ type: 'CUSTOM', name: 'agentport.closed', value: event });
    this.stop();
    this.#finish();
  }

  #prompt(promptId: string): PromptState {
    const existing = this.#prompts.get(promptId);
    if (existing) return existing;

    const pending = this.#pendingRuns.find((run) => run.promptId === undefined);
    if (pending) {
      pending.promptId = promptId;
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
    this.#emit({ type: 'RUN_STARTED', threadId: this.#session.id, runId: prompt.runId });
    return prompt;
  }

  #removePending(pending: PendingRun): void {
    const index = this.#pendingRuns.indexOf(pending);
    if (index !== -1) this.#pendingRuns.splice(index, 1);
  }

  #closePrompt(promptId: string, prompt: PromptState): void {
    if (prompt.textStarted) this.#emit({ type: 'TEXT_MESSAGE_END', messageId: promptId });
    if (!prompt.reasoningStarted) return;
    const messageId = this.#reasoningId(promptId);
    this.#emit({ type: 'REASONING_MESSAGE_END', messageId });
    this.#emit({ type: 'REASONING_END', messageId });
  }

  #emitRunError(runId: string, error: unknown): void {
    this.#emit({
      type: 'RUN_ERROR',
      message: error instanceof Error ? error.message : String(error),
      code: 'AGENTPORT_RUN_ERROR',
      rawEvent: { runId },
    });
  }

  #reasoningId(promptId: string): string {
    return `${promptId}:reasoning`;
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
export function aguiStream(session: AgentSession): AguiAdapter {
  const events = new EventQueue();
  const translator = new Translator(session, (event) => events.push(event), () => events.end());
  events.onReturn(() => translator.stop());
  return { events, run: (text) => translator.run(text) };
}

/** Subscribe without a stream abstraction; returns a listener teardown function. */
export function onAguiEvent(session: AgentSession, callback: (event: AguiEvent) => void): () => void {
  const translator = new Translator(session, callback, () => undefined);
  return () => translator.stop();
}
