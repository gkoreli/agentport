import { WebSocket } from 'ws';
import {
  Deferred,
  Emitter,
  PROTOCOL_VERSION,
  SEALED_TYPES,
  authChallengeMessage,
  decodeFrame,
  deriveSealKey,
  encodeFrame,
  fingerprintWords,
  generateSealKeyPair,
  openSealed,
  randomId,
  seal,
  sign,
  signEpk,
  verifyEpk,
  type AgentCert,
  type CapabilityGrant,
  type Frame,
  type HistoryEntry,
  type KeyPair,
  type SessionFrame,
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
  /**
   * The conversation, recorded on the user's own machine. This is the
   * authoritative transcript: the relay stores none of it, and the website is
   * expected to keep none of it across a reload.
   */
  transcript: HistoryEntry[];
  toolCalls: Map<string, Deferred<unknown>>;
  approvals: Map<string, Deferred<boolean>>;
  prompts: Map<string, AbortController>;
  /** Symmetric key sealing this attachment's content frames (ADR-003). */
  sealKey?: Uint8Array;
}

/** Frames a client may legitimately put inside a sealed envelope. */
const CLIENT_SEALABLE = new Set<string>(['prompt', 'prompt.cancel', 'tool.result', 'approval.response', 'history.request']);

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
  onConnectOffer?: (offer: {
    code: string;
    surface: SurfaceDescriptor;
    grant: CapabilityGrant;
    /**
     * Fingerprint words over both ephemeral keys, when the widget sent one.
     * Show these on the consent screen: if they match what the page displays,
     * no relay sat in the middle of the key exchange.
     */
    verify?: string;
  }) => Promise<boolean>;
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
  /** Sealing keypairs minted at connect-offer time, keyed by the client epk. */
  #offerSeals = new Map<string, KeyPair>();
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

  /**
   * All session content leaves through here: sealed whenever the attachment
   * has a key, so the relay carries ciphertext. Lifecycle frames and sessions
   * opened by a peer that never sent an epk fall back to plaintext.
   */
  #sendSession(session: SessionState, frame: SessionFrame): void {
    if (session.sealKey && SEALED_TYPES.has(frame.t)) this.#send(seal(session.sealKey, frame));
    else this.#send(frame);
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
        // Mint our sealing key now so the consent screen can show the
        // fingerprint words BEFORE anyone approves. Reused at session.open,
        // matched by the client epk the open carries.
        let verify: string | undefined;
        if (frame.epk && frame.epkSig && frame.client) {
          if (!verifyEpk(frame.client, 'connect', frame.epk, frame.epkSig)) {
            this.#send({ t: 'connect.reject', code: frame.code, reason: 'bad_epk_proof' });
            return;
          }
          const mine = generateSealKeyPair();
          this.#offerSeals.set(frame.epk, mine);
          verify = fingerprintWords(frame.epk, mine.publicKey);
        }
        const accepted = (await this.#options.onConnectOffer?.({ ...frame, verify })) ?? false;
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

      case 'enc': {
        const session = this.#sessions.get(frame.s);
        if (!session?.sealKey) {
          this.#log(`sealed frame for ${frame.s} but no key — dropping`);
          return;
        }
        let inner: SessionFrame;
        try {
          inner = openSealed(session.sealKey, frame);
        } catch (err) {
          this.#log(`failed to open sealed frame on ${frame.s}: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        // The relay can no longer see inner types, so the origination check
        // the relay used to make lives here now.
        if (!CLIENT_SEALABLE.has(inner.t)) {
          this.#log(`client sealed a frame it may not originate (${inner.t}) — dropping`);
          return;
        }
        return this.#onFrame(inner);
      }

      case 'session.rekey': {
        const session = this.#sessions.get(frame.s);
        if (!session) return;
        // A refreshed page re-attaches with a fresh identity and a fresh epk;
        // the relay already checked the resume token and stamped the identity.
        if (!verifyEpk(frame.client, frame.s, frame.epk, frame.epkSig)) {
          this.#log(`rekey epk proof failed on ${frame.s} — ignoring`);
          return;
        }
        const mine = generateSealKeyPair();
        session.sealKey = deriveSealKey(mine.secretKey, frame.epk, frame.s);
        this.#send({
          t: 'session.rekeyed',
          s: frame.s,
          epk: mine.publicKey,
          epkSig: signEpk(this.#options.identity.secretKey, frame.s, mine.publicKey),
        });
        this.#log(`session ${frame.s} re-keyed for a resumed client`);
        return;
      }

      case 'session.close': {
        const session = this.#sessions.get(frame.s);
        if (session) await this.#closeSession(session, frame.reason ?? 'client_closed', false);
        return;
      }

      case 'history.request': {
        const session = this.#sessions.get(frame.s);
        if (!session) return;
        // The runtime's own store is authoritative — it is the same history
        // the user sees in their agent, on their disk. Ours is only a
        // fallback for runtimes that persist nothing.
        const replayed = await session.runtime.replayHistory?.().catch((err: unknown) => {
          this.#log(`history replay failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        });
        this.#sendSession(session, { t: 'history', s: frame.s, entries: replayed ?? session.transcript });
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

    // Sealing handshake. The epk proof is signed by the client identity the
    // relay stamped, over a scope that stops replay into another session
    // ('connect' pre-session for the drop-in flow, the session id otherwise).
    let sealKey: Uint8Array | undefined;
    let myEpk: { epk: string; epkSig: string } | undefined;
    if (frame.epk && frame.epkSig && frame.client) {
      const scope = frame.viaConnect ? 'connect' : frame.s;
      if (!verifyEpk(frame.client, scope, frame.epk, frame.epkSig)) {
        this.#send({ t: 'session.denied', s: frame.s, reason: 'bad_epk_proof' });
        return;
      }
      // Reuse the keypair minted at consent time so the fingerprint the user
      // just compared is the fingerprint the session actually uses.
      const mine = this.#offerSeals.get(frame.epk) ?? generateSealKeyPair();
      this.#offerSeals.delete(frame.epk);
      sealKey = deriveSealKey(mine.secretKey, frame.epk, frame.s);
      myEpk = {
        epk: mine.publicKey,
        epkSig: signEpk(this.#options.identity.secretKey, frame.s, mine.publicKey),
      };
    }

    const runtime = this.#options.createRuntime();
    const session: SessionState = {
      id: frame.s,
      viaConnect: Boolean(frame.viaConnect),
      surface: frame.surface,
      grant: frame.grant,
      tools: frame.grant.tools,
      runtime,
      transcript: [],
      toolCalls: new Map(),
      approvals: new Map(),
      prompts: new Map(),
      sealKey,
    };
    this.#sessions.set(frame.s, session);

    await runtime.openSession?.({ surface: session.surface, grant: session.grant, tools: session.tools });

    this.#send({
      t: 'session.opened',
      s: frame.s,
      agentName: this.#options.identity.name,
      runtime: this.#options.identity.runtime,
      ...(myEpk ?? {}),
    });
    this.emit('session', frame.s);
    this.#log(`session ${frame.s} opened by ${frame.surface.name} (${frame.surface.origin}) with ${session.tools.length} tool(s)`);
  }

  async #onPrompt(frame: Extract<Frame, { t: 'prompt' }>): Promise<void> {
    const session = this.#sessions.get(frame.s);
    if (!session) return;

    const controller = new AbortController();
    session.prompts.set(frame.id, controller);

    const record = (role: HistoryEntry['role'], text: string) => {
      const last = session.transcript[session.transcript.length - 1];
      // Streamed deltas arrive token by token; coalesce them into one line so
      // a replay reads like the conversation rather than like the wire.
      if (last && last.role === role && role === 'agent') last.text += text;
      else session.transcript.push({ role, text, at: Date.now() });
    };

    record('user', frame.text);

    const ctx: TurnContext = {
      surface: session.surface,
      grant: session.grant,
      tools: session.tools,
      signal: controller.signal,
      say: (text) => {
        record('agent', text);
        this.#sendSession(session, { t: 'delta', s: session.id, promptId: frame.id, text });
      },
      think: (text) => {
        record('thought', text);
        this.#sendSession(session, { t: 'thought', s: session.id, promptId: frame.id, text });
      },
      callTool: async (name, args) => {
        try {
          const result = await this.#callTool(session, name, args);
          record('tool', name);
          return result;
        } catch (err) {
          record('tool', `${name} — ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      },
      requestApproval: async (summary, call) => {
        const granted = await this.#requestApproval(session, summary, call);
        record('approval', `${summary} — ${granted ? 'allowed' : 'declined'}`);
        return granted;
      },
    };

    try {
      await session.runtime.prompt(frame.text, ctx);
      this.#sendSession(session, {
        t: 'done',
        s: session.id,
        promptId: frame.id,
        stopReason: controller.signal.aborted ? 'cancelled' : 'end_turn',
      });
    } catch (err) {
      this.#sendSession(session, {
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
    this.#sendSession(session, { t: 'tool.call', s: session.id, id, name, arguments: args });
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
    this.#sendSession(session, { t: 'approval.request', s: session.id, id, summary, ...(call ? { call } : {}) });
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
