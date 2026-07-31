import { WebSocket } from 'ws';
import {
  Deferred,
  Emitter,
  PROTOCOL_VERSION,
  authChallengeMessage,
  decodeFrame,
  encodeFrame,
  randomId,
  sign,
  type AgentCert,
  type CapabilityGrant,
  type Frame,
  type SurfaceDescriptor,
  type ToolDefinition,
} from '@agentport/protocol';
import type { AgentIdentity } from './identity.js';
import type { AgentRuntime, TurnContext } from './runtime.js';

interface SessionState {
  id: string;
  /** Came from a drop-in widget, so approvals belong here, not in the page. */
  viaConnect: boolean;
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  tools: ToolDefinition[];
  runtime: AgentRuntime;
  toolCalls: Map<string, Deferred<unknown>>;
  approvals: Map<string, Deferred<boolean>>;
  prompts: Map<string, AbortController>;
}

export interface DaemonOptions {
  relayUrl: string;
  identity: AgentIdentity;
  createRuntime: () => AgentRuntime;
  /** Called with the pairing code when the agent is not yet bound to a user. */
  onPairingCode?: (code: string, expiresAt: number) => void;
  /** Called once the user has signed a cert for this agent. */
  onBound?: (cert: AgentCert) => void;
  /**
   * A drop-in widget somewhere is asking this agent for a session. This is the
   * consent moment for the connect.js flow, and it happens *here* — where the
   * key is — rather than in a browser the site controls.
   */
  onConnectOffer?: (offer: { code: string; surface: SurfaceDescriptor; grant: CapabilityGrant }) => Promise<boolean>;
  /**
   * Approval for a single gated tool call in a connect.js session. Same
   * reasoning: the requesting page must not be the one saying yes.
   */
  onLocalApproval?: (summary: string, call?: { name: string; arguments: Record<string, unknown> }) => Promise<boolean>;
  log?: (message: string) => void;
}

type DaemonEvents = {
  ready: { bound: boolean };
  bound: AgentCert;
  session: string;
  closed: undefined;
};

export class AgentDaemon extends Emitter<DaemonEvents> {
  #options: DaemonOptions;
  #socket: WebSocket | undefined;
  #sessions = new Map<string, SessionState>();
  #log: (message: string) => void;
  #readyDeferred = new Deferred<{ bound: boolean }>();

  constructor(options: DaemonOptions) {
    super();
    this.#options = options;
    this.#log = options.log ?? (() => {});
  }

  get identity(): AgentIdentity {
    return this.#options.identity;
  }

  async start(): Promise<{ bound: boolean }> {
    const socket = new WebSocket(this.#options.relayUrl);
    this.#socket = socket;

    socket.on('open', () => {
      this.#send({ t: 'hello', v: PROTOCOL_VERSION, role: 'agent' });
    });
    socket.on('message', (data) => {
      let frame: Frame;
      try {
        frame = decodeFrame(data.toString());
      } catch (err) {
        this.#log(`dropped undecodable frame: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      void this.#onFrame(frame);
    });
    socket.on('close', () => this.emit('closed', undefined));
    socket.on('error', (err) => this.#readyDeferred.reject(err));

    return this.#readyDeferred.promise;
  }

  /** Claim a connect code the user pasted here from a website's widget. */
  claimConnect(code: string): void {
    this.#send({ t: 'connect.claim', code });
  }

  async stop(): Promise<void> {
    for (const session of this.#sessions.values()) await this.#closeSession(session, 'daemon_stopping');
    this.#socket?.close();
  }

  #send(frame: Frame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(encodeFrame(frame));
  }

  // -------------------------------------------------------------------------

  async #onFrame(frame: Frame): Promise<void> {
    switch (frame.t) {
      case 'challenge': {
        const identity = this.#options.identity;
        this.#send({
          t: 'identify',
          pubkey: identity.publicKey,
          sig: sign(identity.secretKey, authChallengeMessage(frame.nonce)),
          ...(identity.cert ? { cert: identity.cert } : {}),
          announce: { name: identity.name, runtime: identity.runtime, location: identity.location },
        });
        return;
      }

      case 'ready': {
        const bound = Boolean(frame.bound);
        this.emit('ready', { bound });
        this.#readyDeferred.resolve({ bound });
        if (!bound) this.#send({ t: 'pair.begin' });
        return;
      }

      case 'pair.pending':
        this.#options.onPairingCode?.(frame.code, frame.expiresAt);
        return;

      case 'connect.offer': {
        const accepted = (await this.#options.onConnectOffer?.(frame)) ?? false;
        this.#send(
          accepted
            ? { t: 'connect.accept', code: frame.code }
            : { t: 'connect.reject', code: frame.code, reason: 'declined_by_owner' },
        );
        return;
      }

      case 'pair.bound':
        this.#options.identity.cert = frame.cert;
        this.#options.onBound?.(frame.cert);
        this.emit('bound', frame.cert);
        return;

      case 'session.open':
        return this.#onSessionOpen(frame);

      case 'session.close': {
        const session = this.#sessions.get(frame.s);
        if (session) await this.#closeSession(session, frame.reason ?? 'client_closed', false);
        return;
      }

      case 'prompt':
        return this.#onPrompt(frame);

      case 'prompt.cancel': {
        this.#sessions.get(frame.s)?.prompts.get(frame.id)?.abort();
        return;
      }

      case 'tool.result': {
        const pending = this.#sessions.get(frame.s)?.toolCalls.get(frame.id);
        if (!pending) return;
        this.#sessions.get(frame.s)!.toolCalls.delete(frame.id);
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(frame.error ?? 'tool call failed'));
        return;
      }

      case 'approval.response': {
        const pending = this.#sessions.get(frame.s)?.approvals.get(frame.id);
        if (!pending) return;
        this.#sessions.get(frame.s)!.approvals.delete(frame.id);
        pending.resolve(frame.granted);
        return;
      }

      case 'error':
        this.#log(`relay error ${frame.code}: ${frame.message}`);
        return;

      default:
        return;
    }
  }

  async #onSessionOpen(frame: Extract<Frame, { t: 'session.open' }>): Promise<void> {
    // Local policy lives here. A real daemon would consult a per-origin
    // allowlist; v0 accepts any session the relay authorised, but still
    // refuses grants it cannot honour.
    if (frame.grant.expiresAt <= Date.now()) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
      return;
    }

    const runtime = this.#options.createRuntime();
    const session: SessionState = {
      id: frame.s,
      viaConnect: Boolean(frame.viaConnect),
      surface: frame.surface,
      grant: frame.grant,
      tools: frame.grant.tools,
      runtime,
      toolCalls: new Map(),
      approvals: new Map(),
      prompts: new Map(),
    };
    this.#sessions.set(frame.s, session);

    await runtime.openSession?.({ surface: session.surface, grant: session.grant, tools: session.tools });

    this.#send({
      t: 'session.opened',
      s: frame.s,
      agentName: this.#options.identity.name,
      runtime: this.#options.identity.runtime,
    });
    this.emit('session', frame.s);
    this.#log(`session ${frame.s} opened by ${frame.surface.name} (${frame.surface.origin}) with ${session.tools.length} tool(s)`);
  }

  async #onPrompt(frame: Extract<Frame, { t: 'prompt' }>): Promise<void> {
    const session = this.#sessions.get(frame.s);
    if (!session) return;

    const controller = new AbortController();
    session.prompts.set(frame.id, controller);

    const ctx: TurnContext = {
      surface: session.surface,
      grant: session.grant,
      tools: session.tools,
      signal: controller.signal,
      say: (text) => this.#send({ t: 'delta', s: session.id, promptId: frame.id, text }),
      think: (text) => this.#send({ t: 'thought', s: session.id, promptId: frame.id, text }),
      callTool: (name, args) => this.#callTool(session, name, args),
      requestApproval: (summary, call) => this.#requestApproval(session, summary, call),
    };

    try {
      await session.runtime.prompt(frame.text, ctx);
      this.#send({
        t: 'done',
        s: session.id,
        promptId: frame.id,
        stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn',
      });
    } catch (err) {
      this.#send({
        t: 'done',
        s: session.id,
        promptId: frame.id,
        stopReason: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      session.prompts.delete(frame.id);
    }
  }

  async #callTool(session: SessionState, name: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = session.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool "${name}" is not in this session's grant`);
    if (session.grant.expiresAt <= Date.now()) throw new Error('capability grant expired');

    // In a wallet session the browser enforces the site's `requiresApproval`
    // flag. In a connect.js session there is no wallet in the browser, so the
    // gate moves here — to the owner — rather than being silently dropped.
    if (session.viaConnect && (tool.requiresApproval || session.grant.alwaysAsk.includes(name))) {
      const approved = await (this.#options.onLocalApproval?.(`Run ${name}`, { name, arguments: args }) ??
        Promise.resolve(false));
      if (!approved) throw new Error('declined by owner');
    }

    const id = randomId('call_');
    const deferred = new Deferred<unknown>();
    session.toolCalls.set(id, deferred);
    this.#send({ t: 'tool.call', s: session.id, id, name, arguments: args });
    return deferred.promise;
  }

  #requestApproval(
    session: SessionState,
    summary: string,
    call?: { name: string; arguments: Record<string, unknown> },
  ): Promise<boolean> {
    // In a connect.js session the browser side is an ephemeral key belonging to
    // the site. Asking it for approval would be asking the requester for
    // permission, so the question goes to the owner instead.
    if (session.viaConnect) {
      const ask = this.#options.onLocalApproval;
      if (!ask) return Promise.resolve(false);
      return ask(summary, call);
    }

    const id = randomId('appr_');
    const deferred = new Deferred<boolean>();
    session.approvals.set(id, deferred);
    this.#send({ t: 'approval.request', s: session.id, id, summary, ...(call ? { call } : {}) });
    return deferred.promise;
  }

  async #closeSession(session: SessionState, reason: string, notify = true): Promise<void> {
    for (const controller of session.prompts.values()) controller.abort();
    for (const pending of session.toolCalls.values()) pending.reject(new Error('session closed'));
    for (const pending of session.approvals.values()) pending.resolve(false);
    await session.runtime.closeSession?.();
    this.#sessions.delete(session.id);
    if (notify) this.#send({ t: 'session.close', s: session.id, reason });
    this.#log(`session ${session.id} closed (${reason})`);
  }
}
