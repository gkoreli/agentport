import {
  Deferred,
  Emitter,
  type ApprovalRequest,
  type CapabilityGrant,
  type Frame,
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
  #send: (frame: SessionFrame) => void;
  #transcripts = new Map<string, { text: string; deferred: Deferred<string> }>();
  #closed = false;

  constructor(init: {
    id: string;
    surface: SurfaceDescriptor;
    grant: CapabilityGrant;
    info: SessionInfo;
    tools: SiteTool[];
    decide: ApprovalDecider;
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
    this.#send = init.send;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Send a prompt; resolves with the full assistant text for that turn. */
  prompt(text: string, context?: Record<string, unknown>): Promise<string> {
    if (this.#closed) return Promise.reject(new Error('session is closed'));
    const id = `p_${Math.random().toString(36).slice(2, 10)}`;
    const deferred = new Deferred<string>();
    this.#transcripts.set(id, { text: '', deferred });
    this.#send({ t: 'prompt', s: this.id, id, text, ...(context ? { context } : {}) });
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
      const granted = await this.#decide(prompt);
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
      const error = err instanceof Error ? err.message : String(err);
      this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: false, error });
      this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: false, error });
    }
  }

  async #onApproval(frame: ApprovalRequest): Promise<void> {
    const prompt: ApprovalPrompt = { summary: frame.summary, call: frame.call };
    const granted = await this.#decide(prompt);
    this.emit('approval', { ...prompt, granted });
    this.#send({ t: 'approval.response', s: this.id, id: frame.id, granted });
  }

  #finish(reason: string): void {
    this.#closed = true;
    for (const turn of this.#transcripts.values()) turn.deferred.reject(new Error(`session closed: ${reason}`));
    this.#transcripts.clear();
    this.emit('closed', { reason });
  }
}
