import {
  Deferred,
  Emitter,
  createLogger,
  toErr,
  type ApprovalRequest,
  type CapabilityGrant,
  type Frame,
  type HistoryEntry,
  type Logger,
  type SessionFrame,
  type SurfaceDescriptor,
  type ToolDefinition,
} from '@agentport/protocol';

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/** A site tool: the definition the agent sees plus the code that runs it. */
export interface SiteTool extends ToolDefinition {
  handler: ToolHandler;
}

export interface ApprovalPrompt {
  summary: string;
  call?: { name: string; arguments: Record<string, unknown> };
}

export type ApprovalDecider = (prompt: ApprovalPrompt) => boolean | Promise<boolean>;

export type SessionEvents = {
  delta: { promptId: string; text: string };
  thought: { promptId: string; text: string };
  done: { promptId: string; stopReason: string; error?: string };
  tool: { name: string; arguments: Record<string, unknown>; ok: boolean; result?: unknown; error?: string };
  approval: ApprovalPrompt & { granted: boolean };
  closed: { reason: string };
};

export interface SessionInfo {
  agentName: string;
  runtime: string;
  /**
   * Fingerprint words for this attachment's sealing keys.
   * Render them: the daemon consent screen shows the same words, and a match
   * proves the relay did not sit in the key exchange. All sessions are sealed.
   */
  verify?: string;
}

export interface PromptRequest {
  id: string;
  result: Promise<string>;
}

/**
 * One live attachment between this page and one agent.
 *
 * The page owns the tools; the agent may only call what the grant contains,
 * and the relay enforces that only session participants can speak.
 */
export class AgentSession extends Emitter<SessionEvents> {
  readonly id: string;
  readonly surface: SurfaceDescriptor;
  readonly grant: CapabilityGrant;
  readonly info: SessionInfo;

  #tools: Map<string, SiteTool>;
  #alwaysAsk: Set<string>;
  #decide: ApprovalDecider;
  #log: Logger;
  #send: (frame: SessionFrame) => void;
  #transcripts = new Map<string, { text: string; deferred: Deferred<string> }>();
  #historyWaiters: Deferred<HistoryEntry[]>[] = [];
  #closed = false;

  constructor(init: {
    id: string;
    surface: SurfaceDescriptor;
    grant: CapabilityGrant;
    info: SessionInfo;
    tools: SiteTool[];
    decide: ApprovalDecider;
    logger?: Logger;
    send: (frame: SessionFrame) => void;
  }) {
    super();
    this.id = init.id;
    this.surface = init.surface;
    this.grant = init.grant;
    this.info = init.info;
    this.#tools = new Map(init.tools.map((tool) => [tool.name, tool]));
    this.#alwaysAsk = new Set(init.grant.alwaysAsk);
    this.#decide = init.decide;
    this.#log = init.logger ?? createLogger('client.session');
    this.#send = init.send;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Send a prompt; resolves with the full assistant text for that turn. */
  prompt(text: string, context?: Record<string, unknown>): Promise<string> {
    return this.startPrompt(text, context).result;
  }

  /**
   * Start a prompt while exposing its cancellation identity immediately.
   * Renderers need this before the first token arrives; waiting for a delta
   * makes a visible Stop control lie during slow and tool-only turns.
   */
  startPrompt(text: string, context?: Record<string, unknown>, promptId?: string): PromptRequest {
    // Ids are client-minted correlation handles with no security meaning, so
    // a bridged caller (the extension's page proxy) may supply its own and
    // see it echoed on every event.
    const id = promptId ?? `p_${Math.random().toString(36).slice(2, 10)}`;
    if (this.#closed) return { id, result: Promise.reject(new Error('session is closed')) };
    const deferred = new Deferred<string>();
    this.#transcripts.set(id, { text: '', deferred });
    this.#send({ t: 'prompt', s: this.id, id, text, ...(context ? { context } : {}) });
    return { id, result: deferred.promise };
  }

  /**
   * Ask the agent for the conversation it already has.
   *
   * The site deliberately keeps no transcript of its own across reloads: the
   * history lives on the user's machine, in their agent's session store, and
   * is fetched from there.
   */
  history(): Promise<HistoryEntry[]> {
    if (this.#closed) return Promise.reject(new Error('session is closed'));
    const deferred = new Deferred<HistoryEntry[]>();
    this.#historyWaiters.push(deferred);
    this.#send({ t: 'history.request', s: this.id });
    return deferred.promise;
  }

  cancel(promptId: string): void {
    this.#send({ t: 'prompt.cancel', s: this.id, id: promptId });
  }

  close(reason = 'user_closed'): void {
    if (this.#closed) return;
    this.#send({ t: 'session.close', s: this.id, reason });
    this.#finish(reason);
  }

  /** @internal — called by the wallet for frames addressed to this session. */
  async handle(frame: Frame): Promise<void> {
    switch (frame.t) {
      case 'delta': {
        const turn = this.#transcripts.get(frame.promptId);
        if (turn) turn.text += frame.text;
        this.emit('delta', { promptId: frame.promptId, text: frame.text });
        return;
      }
      case 'thought':
        this.emit('thought', { promptId: frame.promptId, text: frame.text });
        return;
      case 'done': {
        const turn = this.#transcripts.get(frame.promptId);
        this.#transcripts.delete(frame.promptId);
        this.emit('done', { promptId: frame.promptId, stopReason: frame.stopReason, error: frame.error });
        if (!turn) return;
        if (frame.stopReason === 'error') turn.deferred.reject(new Error(frame.error ?? 'agent error'));
        else turn.deferred.resolve(turn.text);
        return;
      }
      case 'history': {
        this.#historyWaiters.shift()?.resolve(frame.entries);
        return;
      }
      case 'tool.call':
        return this.#onToolCall(frame);
      case 'approval.request':
        return this.#onApproval(frame);
      case 'session.close':
        this.#finish(frame.reason ?? 'agent_closed');
        return;
      default:
        return;
    }
  }

  async #onToolCall(frame: Extract<Frame, { t: 'tool.call' }>): Promise<void> {
    const tool = this.#tools.get(frame.name);
    if (!tool) {
      this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: false, error: `unknown tool ${frame.name}` });
      this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: false, error: 'unknown tool' });
      return;
    }

    if (tool.requiresApproval || this.#alwaysAsk.has(frame.name)) {
      const prompt: ApprovalPrompt = {
        summary: `Run ${frame.name}`,
        call: { name: frame.name, arguments: frame.arguments },
      };
      let granted = false;
      try {
        granted = await this.#decide(prompt);
      } catch (err) {
        this.#log.error('tool approval handler failed; declining call', {
          sessionId: this.id,
          err,
          data: { tool: frame.name },
        });
        this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: false, error: 'approval failed' });
        this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: false, error: 'approval failed' });
        return;
      }
      this.emit('approval', { ...prompt, granted });
      if (!granted) {
        this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: false, error: 'declined by user' });
        this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: false, error: 'declined by user' });
        return;
      }
    }

    try {
      const result = await tool.handler(frame.arguments);
      this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: true, result });
      this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: true, result });
    } catch (err) {
      const error = toErr(err).message;
      this.#log.error('site tool handler failed', {
        sessionId: this.id,
        err,
        data: { tool: frame.name },
      });
      this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: false, error });
      this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: false, error });
    }
  }

  async #onApproval(frame: ApprovalRequest): Promise<void> {
    const prompt: ApprovalPrompt = { summary: frame.summary, call: frame.call };
    let granted = false;
    try {
      granted = await this.#decide(prompt);
    } catch (err) {
      this.#log.error('approval handler failed; declining request', {
        sessionId: this.id,
        err,
        data: { approvalId: frame.id },
      });
    }
    this.emit('approval', { ...prompt, granted });
    this.#send({ t: 'approval.response', s: this.id, id: frame.id, granted });
  }

  #finish(reason: string): void {
    this.#closed = true;
    for (const turn of this.#transcripts.values()) turn.deferred.reject(new Error(`session closed: ${reason}`));
    this.#transcripts.clear();
    for (const waiter of this.#historyWaiters) waiter.reject(new Error(`session closed: ${reason}`));
    this.#historyWaiters = [];
    this.emit('closed', { reason });
  }
}
