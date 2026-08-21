import {
  BASE64_PATTERN,
  Deferred,
  Emitter,
  MAX_ERROR_CHARS,
  MAX_PROMPT_BLOCKS,
  MAX_PROMPT_IMAGE_CHARS,
  MAX_PROMPT_TEXT_WITH_BLOCKS_CHARS,
  PROMPT_IMAGE_MIMES,
  MAX_JSON_DEPTH,
  MAX_JSON_LEAF_CHARS,
  MAX_JSON_NODES,
  MAX_REASON_CHARS,
  MAX_TEXT_CHARS,
  WireViolation,
  createLogger,
  hashCall,
  isGated,
  isPromptId,
  jsonValue,
  randomId,
  toErr,
  type ApprovalRequest,
  type AuthorityDomain,
  type FormField,
  type CapabilityGrant,
  type Frame,
  type HistoryEntry,
  type Logger,
  type PlanStep,
  type PromptImage,
  type SessionFrame,
  type SurfaceDescriptor,
  type ToolDefinition,
} from '@agentport/protocol';

export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;

/**
 * Page-supplied values must be clamped BEFORE sealing: the daemon treats a
 * sealed frame that fails strict validation as session-fatal (ADR-019 §1 —
 * AEAD counters cannot skip a frame), so an oversized prompt or tool result
 * that slipped through would kill the whole attachment, not just one call.
 */
const wireJson = jsonValue(MAX_JSON_DEPTH, MAX_JSON_NODES, MAX_JSON_LEAF_CHARS);

/**
 * Validate page-supplied JSON in the exact form it takes on the wire: the
 * frame is JSON.stringify'd at seal time, so the round-tripped value — not
 * the live object with its prototypes, Dates, and toJSON hooks — is what the
 * daemon will validate. Throws WireViolation (bounds) or TypeError (cycles,
 * BigInt); callers decide whether that rejects the call or degrades it.
 */
function toWireJson(value: unknown): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new WireViolation('wrong_type', '');
  return wireJson(JSON.parse(encoded), '');
}

/** Clamp a page-supplied operational string to its wire bound, visibly. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Why this prompt's attachments cannot go on the wire, in words a composer
 * can show — or undefined when they can. The same rules the schema enforces
 * (`messages.ts#PromptImage` and the Prompt refinement), asked BEFORE sealing
 * because a sealed frame the daemon rejects is session-fatal, not call-fatal.
 */
function describeBlockProblem(text: string, blocks: readonly PromptImage[]): string | undefined {
  if (blocks.length > MAX_PROMPT_BLOCKS) return `at most ${MAX_PROMPT_BLOCKS} images per prompt`;
  let total = 0;
  for (const block of blocks) {
    if (!(PROMPT_IMAGE_MIMES as readonly string[]).includes(block.mime)) {
      return `unsupported image type ${block.mime}; use ${PROMPT_IMAGE_MIMES.join(', ')}`;
    }
    if (!BASE64_PATTERN.test(block.data) || block.data.length % 4 !== 0) {
      return 'image data must be standard base64';
    }
    total += block.data.length;
  }
  if (total > MAX_PROMPT_IMAGE_CHARS) {
    return `images total ${Math.round((total * 3) / 4 / 1024)} KiB; the limit is ${Math.round((MAX_PROMPT_IMAGE_CHARS * 3) / 4 / 1024)} KiB per prompt`;
  }
  if (text.length > MAX_PROMPT_TEXT_WITH_BLOCKS_CHARS) {
    return `a prompt carrying images is limited to ${MAX_PROMPT_TEXT_WITH_BLOCKS_CHARS} characters of text`;
  }
  return undefined;
}

/** A site tool: the definition the agent sees plus the code that runs it. */
export interface SiteTool extends ToolDefinition {
  handler: ToolHandler;
}

export interface ApprovalPrompt {
  /**
   * WHICH authority is being asked about (ADR-023). A renderer must say this
   * in words a human recognises — "your agent's own tool" versus "a tool this
   * site lent it" — because it is the distinction that makes the question
   * answerable. `site_tool` is bounded by the signed grant; `runtime_own_tool`
   * is the agent's own capability on the user's machine, bounded by nothing
   * the site can see.
   */
  domain: AuthorityDomain;
  /** Agent-authored, therefore untrusted. Never present it as verified fact. */
  summary: string;
  call?: { name: string; arguments: Record<string, unknown> };
}

export type ApprovalDecider = (prompt: ApprovalPrompt) => boolean | Promise<boolean>;

export type SessionEvents = {
  delta: { promptId: string; text: string };
  thought: { promptId: string; text: string };
  /**
   * The agent is asking its user a question (ADR-024). Answer it with
   * `session.answer(id, …)`. If nothing answers, the daemon proceeds as
   * skipped after its own deadline — an unanswered question never hangs the
   * turn.
   */
  ask: { id: string; message: string; fields: FormField[] };
  /** The agent's current plan for a prompt. Each event replaces the last. */
  plan: { promptId: string; steps: PlanStep[] };
  /** The socket dropped and this attachment was re-established, with fresh
   *  sealing keys — so the fingerprint words change too. */
  reattached: { verify?: string };
  done: { promptId: string; stopReason: string; error?: string };
  tool: { name: string; arguments: Record<string, unknown>; ok: boolean; result?: unknown; error?: string };
  approval: ApprovalPrompt & { granted: boolean };
  closed: { reason: string };
};

export interface SessionInfo {
  agentName: string;
  /**
   * Present only when this client is the user's own key (v7). A page tier is
   * deliberately not told which runtime the user runs — it is the first item
   * on the north star's "the site learns nothing" list — so a renderer must
   * treat absence as the ordinary case, not a loading state.
   */
  runtime?: string;
  /**
   * Fingerprint words for this attachment's sealing keys.
   * Render them: the daemon consent screen shows the same words, and a match
   * proves the relay did not sit in the key exchange. All sessions are sealed.
   */
  verify?: string;
  /**
   * Whether the agent may use its OWN tools during this attachment — its
   * shell, its files, whatever its runtime carries (ADR-024 R11).
   *
   * False wherever this page is the only surface that could answer an
   * own-tool approval, which is every tier without a wallet the site cannot
   * draw. The daemon refuses those approvals rather than asking the page
   * whether the agent may use the user's own machine.
   *
   * REQUIRED, and it must be RENDERED. An agent that quietly cannot use half
   * of itself is the invisible diminishment this project keeps re-learning:
   * the model experiences an absent affordance as nothing at all and guesses,
   * so the only party who can act on this is the user, and only if someone
   * tells them. Say it where they are looking: "on this site your agent works
   * with the site's tools only".
   */
  ownTools: boolean;
}

export interface PromptRequest {
  id: string;
  result: Promise<string>;
}

/** The page-safe contract shared by direct wallets and extension proxies. */
export interface AgentSessionHandle {
  readonly id: string;
  readonly grant: CapabilityGrant;
  readonly info: SessionInfo;
  readonly closed: boolean;
  /**
   * `blocks` (v7): images attached to this prompt, upload direction only.
   * CONTRACT for implementers: forward them or REJECT the call when any are
   * passed — never accept-and-drop, because an attachment the agent never
   * saw makes it answer a question about an image it never received. (The
   * extension's page proxy currently declares the shorter signature and its
   * bridge admits no blocks from page world, so no path reaches it; carrying
   * blocks across that boundary is deferred, recorded at `PageSession`.)
   */
  prompt(text: string, context?: Record<string, unknown>, blocks?: readonly PromptImage[]): Promise<string>;
  startPrompt(text: string, context?: Record<string, unknown>, blocks?: readonly PromptImage[]): PromptRequest;
  history(): Promise<HistoryEntry[]>;
  cancel(promptId: string): void;
  answer(askId: string, values?: Record<string, string>): void;
  close(reason?: string): void;
  on<K extends keyof SessionEvents>(event: K, listener: (value: SessionEvents[K]) => void): () => void;
}

/**
 * One live attachment between this page and one agent.
 *
 * The page owns the tools; the agent may only call what the grant contains,
 * and the relay enforces that only session participants can speak.
 */
export class AgentSession extends Emitter<SessionEvents> implements AgentSessionHandle {
  readonly id: string;
  readonly surface: SurfaceDescriptor;
  readonly grant: CapabilityGrant;

  /** The page holds this handle across a reconnect, so what it reports must
   *  follow the live attachment rather than the one that died. */
  get info(): SessionInfo {
    return this.#info;
  }

  #tools: Map<string, SiteTool>;
  #decide: ApprovalDecider;
  #log: Logger;
  #send: (frame: SessionFrame) => void;
  #transcripts = new Map<string, { text: string; deferred: Deferred<string> }>();
  #historyWaiters: Deferred<HistoryEntry[]>[] = [];
  #closed = false;
  // Non-readonly so a reconnect can rekey the attachment in place; `info` is
  // the object the page already holds a reference to.
  #info: SessionInfo;

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
    this.#info = init.info;
    this.#tools = new Map(init.tools.map((tool) => [tool.name, tool]));
    this.#decide = init.decide;
    this.#log = init.logger ?? createLogger('client.session');
    this.#send = init.send;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Send a prompt; resolves with the full assistant text for that turn. */
  prompt(text: string, context?: Record<string, unknown>, blocks?: readonly PromptImage[]): Promise<string> {
    return this.startPrompt(text, context, blocks).result;
  }

  /**
   * Start a prompt while exposing its cancellation identity immediately.
   * Renderers need this before the first token arrives; waiting for a delta
   * makes a visible Stop control lie during slow and tool-only turns.
   *
   * `promptId` trails `blocks` because it is the class-only extension (the
   * extension's worker supplies its own correlation ids); the handle's
   * signature ends at `blocks`.
   */
  startPrompt(
    text: string,
    context?: Record<string, unknown>,
    blocks?: readonly PromptImage[],
    promptId?: string,
  ): PromptRequest {
    // Ids are client-minted correlation handles with no security meaning, so
    // a bridged caller (the extension's page proxy) may supply its own and
    // see it echoed on every event.
    const id = promptId ?? randomId('p_');
    if (!isPromptId(id)) throw new Error('invalid prompt id');
    if (this.#transcripts.has(id)) throw new Error('prompt id is already active');
    if (this.#closed) return { id, result: Promise.reject(new Error('session is closed')) };
    // Rejected, never truncated: silently sending a shortened prompt would
    // have the agent act on words the user did not say.
    if (text.length === 0) {
      return { id, result: Promise.reject(new Error('prompt text is empty')) };
    }
    if (text.length > MAX_TEXT_CHARS) {
      return {
        id,
        result: Promise.reject(new Error(`prompt text exceeds the protocol limit of ${MAX_TEXT_CHARS} characters`)),
      };
    }
    let wireContext: Record<string, unknown> | undefined;
    if (context !== undefined) {
      try {
        wireContext = toWireJson(context) as Record<string, unknown>;
      } catch (err) {
        const code = err instanceof WireViolation ? err.code : 'unserializable';
        return { id, result: Promise.reject(new Error(`prompt context is not valid wire JSON (${code})`)) };
      }
    }
    // Attachments are rejected here with a reason a composer can render,
    // BEFORE sealing — the daemon treats an invalid sealed frame as
    // session-fatal, so the page-side clamp is what keeps one oversized
    // image from killing the whole attachment (same rule as tool results).
    if (blocks && blocks.length > 0) {
      const problem = describeBlockProblem(text, blocks);
      if (problem) return { id, result: Promise.reject(new Error(problem)) };
    }
    const deferred = new Deferred<string>();
    this.#transcripts.set(id, { text: '', deferred });
    this.#send({
      t: 'prompt',
      s: this.id,
      id,
      text,
      ...(wireContext ? { context: wireContext } : {}),
      ...(blocks && blocks.length > 0 ? { blocks: [...blocks] } : {}),
    });
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
    // A malformed id could never name an active prompt, but it WOULD fail the
    // daemon's strict decode inside the sealed channel — which is fatal for
    // the whole session, not just this cancel. Refuse it here instead.
    if (!isPromptId(promptId)) throw new Error('invalid prompt id');
    this.#send({ t: 'prompt.cancel', s: this.id, id: promptId });
  }

  /**
   * Answer a question the agent asked (ADR-024). Omitting `values` — or
   * passing none — is a SKIP, which is a real answer meaning "proceed without
   * one", not an error and not a cancellation.
   */
  answer(askId: string, values?: Record<string, string>): void {
    const entries = Object.entries(values ?? {});
    if (entries.length === 0) {
      this.#send({ t: 'answer', s: this.id, id: askId, outcome: 'skipped' });
      return;
    }
    this.#send({
      t: 'answer',
      s: this.id,
      id: askId,
      outcome: 'answered',
      values: entries.map(([key, value]) => ({ key, value })),
    });
  }

  close(reason = 'user_closed'): void {
    if (this.#closed) return;
    // Clamped, not rejected: a close must always go through, and a reason is
    // operational metadata a trailing ellipsis cannot falsify.
    const wireReason = clip(reason, MAX_REASON_CHARS);
    this.#send({ t: 'session.close', s: this.id, reason: wireReason });
    this.#finish(wireReason);
  }

  /**
   * @internal — the wallet re-established this attachment after the socket
   * dropped, on a fresh sealed channel.
   *
   * The session object survives on purpose: the page holds this handle and its
   * listeners, and a transparent reconnect that handed back a *different*
   * object would be transparent to nobody. What cannot survive is a prompt
   * that was in flight when the socket died — its answer was streamed into a
   * channel nobody was holding, and the relay counts those frames rather than
   * buffering them (ADR-005). So they are rejected here with a stable reason
   * instead of hanging forever, and the truthful record of what the agent
   * actually did is one `history()` call away, from the agent's own store.
   */
  reattached(info: SessionInfo): void {
    this.#info = info;
    for (const turn of this.#transcripts.values()) {
      turn.deferred.reject(new Error('session reconnected: this prompt lost its answer; ask for history'));
    }
    this.#transcripts.clear();
    for (const waiter of this.#historyWaiters) {
      waiter.reject(new Error('session reconnected: history request lost its answer'));
    }
    this.#historyWaiters = [];
    this.emit('reattached', { verify: info.verify });
  }

  /**
   * @internal — the attachment is gone and cannot be restored (the relay never
   * came back, or the resume was refused).
   *
   * Distinct from close(): there is no socket to tell anyone on, so this only
   * settles what the page is waiting for. Sending a session.close here would
   * be a frame into a void.
   */
  dropped(reason: string): void {
    if (this.#closed) return;
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
      case 'ask':
        this.emit('ask', { id: frame.id, message: frame.message, fields: frame.fields });
        return;

      case 'plan':
        // A snapshot replaces the previous plan; the session keeps no copy,
        // because the only consumer that needs one is the view rendering it.
        this.emit('plan', { promptId: frame.promptId, steps: frame.steps });
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
        /* A frame that reached here and matched nothing is DROPPED, and this
       * is the only place that can say so. Not a `never` default: these routers
       * are deliberately partial over the 45-frame union — an endpoint receives
       * a subset, and AGENTS.md warns against making the origination sets total
       * because partial is what makes them fail-closed. So the guard is
       * visibility, not exhaustiveness.
       *
       * It matters because everything upstream conspires to make the frame look
       * handled: `messages.ts` proves at compile time that a new content frame
       * is in `FRAME_SCHEMAS`, in `SESSION_FRAME_TYPES`, and in one of the
       * sealable sets — so it decodes, unseals, routes to the right session,
       * and then vanishes at the door. That is the plain-`Set` bug this repo
       * already paid for, one hop further out.
       *
       * `frame.t` is safe to log: it comes from the exact-`t` registry, so it
       * is a schema-defined name and never attacker-chosen text. */
        this.#log.warn('dropped a frame this session has no handler for', {
          sessionId: this.id,
          data: { frameType: frame.t },
        });
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

    if (isGated(tool, this.grant)) {
      // This one the client knows for itself: the tool came from the grant
      // it registered, so the domain is not taken from anybody's word.
      const prompt: ApprovalPrompt = {
        domain: 'site_tool',
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

    let result: unknown;
    try {
      result = await tool.handler(frame.arguments);
    } catch (err) {
      // The thrown message is page-authored free text; clamp it to the wire
      // bound so reporting one failure cannot cause a second, fatal one.
      const error = clip(toErr(err).message, MAX_ERROR_CHARS);
      this.#log.error('site tool handler failed', {
        sessionId: this.id,
        err,
        data: { tool: frame.name },
      });
      this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: false, error });
      this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: false, error });
      return;
    }

    let wireResult: unknown;
    try {
      wireResult = result === undefined ? undefined : toWireJson(result);
    } catch (err) {
      // A tool result must never kill the session: the daemon rejects any
      // sealed frame failing strict validation as session-fatal, so an
      // out-of-bounds result degrades to a stable error the agent can read.
      const error =
        err instanceof WireViolation ? 'tool result exceeds protocol bounds' : 'tool result is not JSON-serializable';
      this.#log.warn('tool result rejected before sealing', {
        sessionId: this.id,
        data: {
          tool: frame.name,
          ...(err instanceof WireViolation ? { code: err.code, path: err.path } : { code: 'unserializable' }),
        },
      });
      this.#send({ t: 'tool.result', s: this.id, id: frame.id, ok: false, error });
      this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: false, error });
      return;
    }
    this.#send({
      t: 'tool.result',
      s: this.id,
      id: frame.id,
      ok: true,
      ...(wireResult !== undefined ? { result: wireResult } : {}),
    });
    this.emit('tool', { name: frame.name, arguments: frame.arguments, ok: true, result });
  }

  async #onApproval(frame: ApprovalRequest): Promise<void> {
    // The domain is the daemon's stamp, carried through rather than inferred
    // from the summary — which is agent-authored text and can be made to read
    // like anything at all.
    const prompt: ApprovalPrompt = { domain: frame.domain, summary: frame.summary, call: frame.call };
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
    // Recomputed from what the decider was actually shown, never echoed from
    // the request — echoing a peer's digest proves nothing (ADR-023 R6).
    const callHash = prompt.call ? hashCall(prompt.call) : undefined;
    this.#send({
      t: 'approval.response',
      s: this.id,
      id: frame.id,
      granted,
      ...(callHash ? { callHash } : {}),
    });
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
