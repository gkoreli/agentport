import { WebSocket } from 'ws';
import {
  Deferred,
  Emitter,
  PROTOCOL_VERSION,
  SEALED_TYPES,
  answerProofBinding,
  authChallengeMessage,
  createLogger,
  decodeFrame,
  deriveSealChannel,
  encodeFrame,
  fingerprintWords,
  generateSealKeyPair,
  openSealed,
  openProofBinding,
  randomBytes,
  randomId,
  seal,
  sign,
  signEpk,
  resumeProofBinding,
  timingSafeEqualStr,
  toErr,
  toHex,
  verifyEpk,
  verifyDelegation,
  type AgentCert,
  type CapabilityGrant,
  type Frame,
  type HistoryEntry,
  type KeyPair,
  type Logger,
  type LogSink,
  type SessionFrame,
  type SealChannel,
  type SurfaceDescriptor,
  type ToolDefinition,
} from '@agentport/protocol';
import type { AgentIdentity } from './identity.js';
import type { AgentRuntime, TurnContext } from './runtime.js';

interface SessionState {
  id: string;
  /** Came from a drop-in widget, so approvals belong here, not in the page. */
  viaConnect: boolean;
  /** A hosted wallet authorised this page identity for the attachment. */
  delegated: boolean;
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
  sealChannel: SealChannel;
  /**
   * Session authority lives HERE (ADR-016): the daemon mints the resume
   * token, judges resume attempts, survives relay restarts, and counts what
   * the client missed while detached. The relay only ever routes.
   */
  resumeToken: string;
  clientKey?: string;
  detachedAt?: number;
  missed: number;
  resumeAttempts: number;
}

/** How long a detached session is held for a client to come back. */
const DETACH_GRACE_MS = 30 * 60 * 1000;
const MAX_RESUME_ATTEMPTS = 10;

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
  sink?: LogSink;
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
  #log: Logger;
  #readyDeferred = new Deferred<{ bound: boolean }>();
  #authenticated = false;
  #stopped = false;
  #retryMs = 1000;
  #heartbeat: ReturnType<typeof setInterval> | undefined;

  constructor(options: DaemonOptions) {
    super();
    this.#options = options;
    this.#log = createLogger('daemon', { sink: options.sink });
  }

  get identity(): AgentIdentity {
    return this.#options.identity;
  }

  /**
   * Connects, and STAYS connected: a relay redeploy (Durable Objects sever
   * every socket when the Worker updates), an idle eviction, or any network
   * blip is survived by redialing with backoff. Without this the daemon is a
   * zombie after the first deploy — running, but reachable by nobody.
   */
  async start(): Promise<{ bound: boolean }> {
    this.#dial();
    return this.#readyDeferred.promise;
  }

  #dial(): void {
    if (this.#stopped) return;
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
        this.#log.warn('dropped undecodable frame', { err, data: { relayUrl: this.#options.relayUrl } });
        return;
      }
      void this.#onFrame(frame).catch((err: unknown) => {
        this.#log.error('failed to handle relay frame', {
          err,
          ...('s' in frame ? { sessionId: frame.s } : {}),
          data: { frameType: frame.t, relayUrl: this.#options.relayUrl },
        });
      });
    });

    // Half-open sockets (NAT timeouts, silent relay death) look connected
    // forever without this. ws answers our ping with a pong; no pong within
    // the next beat means the pipe is gone.
    let alive = true;
    socket.on('pong', () => (alive = true));
    clearInterval(this.#heartbeat);
    this.#heartbeat = setInterval(() => {
      // Detached sessions do not wait forever: past the grace, close the
      // runtime and forget the token.
      const cutoff = Date.now() - DETACH_GRACE_MS;
      for (const session of [...this.#sessions.values()]) {
        if (session.detachedAt !== undefined && session.detachedAt < cutoff) {
          void this.#closeSession(session, 'client_never_returned', false).catch((err: unknown) => {
            this.#log.error('failed to expire detached session', { sessionId: session.id, err });
          });
        }
      }
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        this.#log.warn('heartbeat lost; terminating socket to force a redial');
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30_000);

    socket.on('close', () => {
      this.#authenticated = false;
      clearInterval(this.#heartbeat);
      // The relay is stateless: losing it detaches every session but kills
      // none. Clients come back with their tokens through whatever relay
      // socket exists next, and this daemon is the one that remembers them.
      const now = Date.now();
      for (const session of this.#sessions.values()) {
        if (session.detachedAt === undefined) session.detachedAt = now;
      }
      this.emit('closed', undefined);
      if (this.#stopped) return;
      const delay = this.#retryMs;
      this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
      this.#log.warn('relay connection lost; scheduling redial', {
        data: { delayMs: delay, relayUrl: this.#options.relayUrl },
      });
      setTimeout(() => this.#dial(), delay);
    });
    socket.on('error', (err) => {
      this.#log.error('relay websocket failed', { err, data: { relayUrl: this.#options.relayUrl } });
      // Before the first ready this is fatal to the caller; afterwards the
      // close handler owns recovery.
      this.#readyDeferred.reject(err);
    });
  }

  /** Claim a connect code the user pasted here from a website's widget. */
  claimConnect(code: string): void {
    this.#send({ t: 'connect.claim', code });
  }

  /** Mint a fresh one-time wallet pairing offer on this authenticated socket. */
  beginPairing(): void {
    if (!this.#authenticated) throw new Error('agent is not connected to the relay');
    this.#send({ t: 'pair.begin' });
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    for (const session of this.#sessions.values()) await this.#closeSession(session, 'daemon_stopping');
    this.#socket?.close();
  }

  #send(frame: Frame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(encodeFrame(frame));
  }

  /**
   * All session content leaves through here: sealed whenever the attachment
   * has a key, so the relay carries ciphertext. Lifecycle frames remain clear
   * because the relay needs them for routing.
   */
  #sendSession(session: SessionState, frame: SessionFrame): void {
    if (session.detachedAt !== undefined && SEALED_TYPES.has(frame.t)) {
      // Nobody is listening; count, never buffer. The conversation already
      // lives in the runtime's own store, which is what replays on resume.
      session.missed++;
      return;
    }
    if (SEALED_TYPES.has(frame.t)) {
      const sealed = seal(session.sealChannel.send, frame);
      this.#send(sealed);
    } else this.#send(frame);
  }

  // -------------------------------------------------------------------------

  async #onFrame(frame: Frame, openedFromSeal = false): Promise<void> {
    if (SEALED_TYPES.has(frame.t) && !openedFromSeal) {
      this.#log.warn('dropped plaintext session content', { sessionId: 's' in frame ? frame.s : undefined, data: { type: frame.t } });
      return;
    }
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
        this.#retryMs = 1000;
        this.#authenticated = true;
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
        if (
          !frame.epk ||
          !frame.epkSig ||
          !frame.client ||
          !verifyEpk(
            frame.client,
            'connect',
            frame.epk,
            frame.epkSig,
            openProofBinding('connect', frame.surface, frame.grant),
          )
        ) {
          this.#send({ t: 'connect.reject', code: frame.code, reason: 'bad_epk_proof' });
          return;
        }
        const mine = generateSealKeyPair();
        this.#offerSeals.set(frame.epk, mine);
        verify = fingerprintWords(frame.epk, mine.publicKey);
        let accepted = false;
        try {
          accepted = (await this.#options.onConnectOffer?.({ ...frame, verify })) ?? false;
        } catch (err) {
          this.#log.error('connect consent handler failed; declining request', {
            err,
            data: { code: frame.code, surface: frame.surface.name },
          });
        }
        if (!accepted) this.#offerSeals.delete(frame.epk);
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

      case 'session.detach': {
        const session = this.#sessions.get(frame.s);
        if (session && session.detachedAt === undefined) {
          session.detachedAt = Date.now();
          // A page-owned tool or approval cannot finish after its execution
          // context disappears. Keeping these promises pending wedges the ACP
          // turn forever and can make the model retry the same MCP call.
          this.#cancelInFlight(session, 'client detached');
          this.#log.info('session detached; holding it for resume', {
            sessionId: frame.s,
            data: { graceMs: DETACH_GRACE_MS },
          });
        }
        return;
      }

      case 'session.resume':
        return this.#onSessionResume(frame);

      case 'enc': {
        const session = this.#sessions.get(frame.s);
        if (!session?.sealChannel) {
          this.#log.warn('dropping sealed frame because the session has no channel', { sessionId: frame.s });
          return;
        }
        let inner: SessionFrame;
        try {
          inner = openSealed(session.sealChannel.receive, frame);
        } catch (err) {
          this.#log.warn('failed to open sealed frame', { sessionId: frame.s, err });
          return;
        }
        // The relay can no longer see inner types, so the origination check
        // the relay used to make lives here now.
        if (!CLIENT_SEALABLE.has(inner.t)) {
          this.#log.warn('client sealed a frame it may not originate; dropping it', {
            sessionId: frame.s,
            data: { frameType: inner.t },
          });
          return;
        }
        return this.#onFrame(inner, true);
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
          this.#log.warn('history replay failed; using observed transcript', { sessionId: frame.s, err });
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
        this.#log.error('relay rejected a frame', { data: { code: frame.code, message: frame.message } });
        return;

      default:
        return;
    }
  }

  /**
   * The daemon rules on a resume: it minted the token, so only it can judge
   * one. One denial reason for anything unprovable — a wrong token must not
   * be distinguishable from a session that never existed — and a constant-time
   * compare so timing does not answer what the message will not.
   */
  #onSessionResume(frame: Extract<Frame, { t: 'session.resume' }>): void {
    const session = this.#sessions.get(frame.s);
    if (!session) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'not_resumable' });
      return;
    }
    if (++session.resumeAttempts > MAX_RESUME_ATTEMPTS) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'not_resumable' });
      return;
    }
    if (!timingSafeEqualStr(session.resumeToken, frame.token)) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'not_resumable' });
      return;
    }
    session.resumeAttempts = 0;
    // Attached means a live client the relay has not reported dead: a valid
    // token must not hijack a session out from under it. The refresh race
    // resolves through the wallet's retry — the detach lands within a second.
    if (session.detachedAt === undefined) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'already_attached' });
      return;
    }
    if (session.grant.expiresAt <= Date.now()) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
      return;
    }
    if (
      !frame.client ||
      !frame.epk ||
      !frame.epkSig ||
      !verifyEpk(
        frame.client,
        frame.s,
        frame.epk,
        frame.epkSig,
        resumeProofBinding(frame.agent, frame.token),
      )
    ) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'bad_epk_proof' });
      return;
    }

    const mine = generateSealKeyPair();
    session.sealChannel = deriveSealChannel(mine.secretKey, frame.epk, frame.s, 'agent');
    session.clientKey = frame.client;
    session.detachedAt = undefined;
    const missed = session.missed;
    session.missed = 0;

    this.#send({
      t: 'session.resumed',
      s: frame.s,
      agentName: session.delegated ? 'Personal agent' : this.#options.identity.name,
      runtime: this.#options.identity.runtime,
      surface: session.surface,
      grant: session.grant,
      missed,
      epk: mine.publicKey,
      epkSig: signEpk(
        this.#options.identity.secretKey,
        frame.s,
        mine.publicKey,
        answerProofBinding('resume', frame.client, frame.epk, session.surface, session.grant, {
          agentName: this.#options.identity.name,
          runtime: this.#options.identity.runtime,
          missed,
        }),
      ),
    });
    this.#log.info('session resumed', { sessionId: frame.s, data: { missedFrames: missed } });
  }

  async #onSessionOpen(frame: Extract<Frame, { t: 'session.open' }>): Promise<void> {
    // Local policy lives here. A real daemon would consult a per-origin
    // allowlist; v0 accepts any session the relay authorised, but still
    // refuses grants it cannot honour.
    if (frame.grant.expiresAt <= Date.now()) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
      return;
    }

    // Invariant 5 at the edge: with a stateless relay, the daemon re-checks
    // the complete proof presented by the opener. A delegation must be signed
    // by this agent's owner, name this agent and the relay-stamped client key,
    // match the forwarded surface origin, and still be live. A lying relay
    // therefore cannot turn a bad delegation into access.
    const cert = this.#options.identity.cert;
    if (frame.delegation) {
      const delegation = frame.delegation;
      if (
        !cert ||
        !verifyDelegation(cert.user, delegation) ||
        delegation.delegate !== frame.client ||
        delegation.agent !== this.#options.identity.publicKey ||
        typeof delegation.origin !== 'string' ||
        delegation.origin !== frame.surface.origin ||
        typeof delegation.expiresAt !== 'number' ||
        !Number.isFinite(delegation.expiresAt) ||
        delegation.expiresAt <= Date.now()
      ) {
        this.#send({ t: 'session.denied', s: frame.s, reason: 'bad_delegation' });
        return;
      }
    } else if (!frame.viaConnect && cert && frame.client !== cert.user) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'not_your_agent' });
      return;
    }

    // Sealing handshake. The epk proof is signed by the client identity the
    // relay stamped, over a scope that stops replay into another session
    // ('connect' pre-session for the drop-in flow, the session id otherwise).
    if (!frame.epk || !frame.epkSig || !frame.client) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'sealing_required' });
      return;
    }
    const scope = frame.viaConnect ? 'connect' : frame.s;
    const requestBinding = frame.viaConnect
      ? openProofBinding('connect', frame.surface, frame.grant)
      : openProofBinding('open', frame.surface, frame.grant, frame.agent);
    if (!verifyEpk(frame.client, scope, frame.epk, frame.epkSig, requestBinding)) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'bad_epk_proof' });
      return;
    }

    // If extension state was lost during an update, it cannot present the old
    // resume token and opens a replacement attachment instead. Retire only an
    // orphan belonging to the same authenticated client and surface before
    // the ACP adapter loads that surface's persisted session. Two live ACP
    // processes must never own one persisted agent session concurrently.
    for (const existing of [...this.#sessions.values()]) {
      if (
        existing.id !== frame.s &&
        existing.detachedAt !== undefined &&
        existing.clientKey === frame.client &&
        existing.surface.origin === frame.surface.origin &&
        existing.surface.name === frame.surface.name
      ) {
        await this.#closeSession(existing, 'replaced_by_new_attachment', false);
      }
    }
    // Reuse the keypair minted at consent time so the fingerprint the user
    // just compared is the fingerprint the session actually uses.
    let mine: KeyPair;
    if (frame.viaConnect) {
      const approved = this.#offerSeals.get(frame.epk);
      if (!approved) {
        this.#send({ t: 'session.denied', s: frame.s, reason: 'connect_not_approved' });
        return;
      }
      mine = approved;
      this.#offerSeals.delete(frame.epk);
    } else {
      mine = generateSealKeyPair();
    }
    const sealChannel = deriveSealChannel(mine.secretKey, frame.epk, frame.s, 'agent');
    const resumeToken = toHex(randomBytes(24));
    // The proof authenticates the exact clear response the client receives.
    // Delegated pages receive a generic label, so signing the private label
    // here would make a valid response unverifiable at the other endpoint.
    const responseAgentName = frame.delegation ? 'Personal agent' : this.#options.identity.name;
    const myEpk = {
      epk: mine.publicKey,
      epkSig: signEpk(
        this.#options.identity.secretKey,
        frame.s,
        mine.publicKey,
        answerProofBinding(frame.viaConnect ? 'connect' : 'open', frame.client, frame.epk, frame.surface, frame.grant, {
          agentName: responseAgentName,
          runtime: this.#options.identity.runtime,
          resume: resumeToken,
        }),
      ),
    };

    const runtime = this.#options.createRuntime();
    const session: SessionState = {
      id: frame.s,
      viaConnect: Boolean(frame.viaConnect),
      delegated: Boolean(frame.delegation),
      surface: frame.surface,
      grant: frame.grant,
      tools: frame.grant.tools,
      runtime,
      transcript: [],
      toolCalls: new Map(),
      approvals: new Map(),
      prompts: new Map(),
      sealChannel,
      resumeToken,
      clientKey: frame.client,
      missed: 0,
      resumeAttempts: 0,
    };
    this.#sessions.set(frame.s, session);

    try {
      await runtime.openSession?.({ surface: session.surface, grant: session.grant, tools: session.tools });
    } catch (err) {
      this.#sessions.delete(frame.s);
      try {
        await runtime.closeSession?.();
      } catch (closeErr) {
        this.#log.error('runtime cleanup failed after session-open failure', {
          sessionId: frame.s,
          err: closeErr,
        });
      }
      this.#log.error('runtime failed to open session', {
        sessionId: frame.s,
        err,
        data: { surface: frame.surface.name, origin: frame.surface.origin },
      });
      this.#send({ t: 'session.denied', s: frame.s, reason: 'runtime_failed' });
      return;
    }

    this.#send({
      t: 'session.opened',
      s: frame.s,
      // A delegated page receives the generic label the hosted wallet showed;
      // the user's real agent name stays inside the wallet-origin popup.
      agentName: responseAgentName,
      runtime: this.#options.identity.runtime,
      resume: session.resumeToken,
      ...myEpk,
    });
    this.emit('session', frame.s);
    this.#log.info('session opened', {
      sessionId: frame.s,
      data: { surface: frame.surface.name, origin: frame.surface.origin, toolCount: session.tools.length },
    });
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
      callTool: async (name, args, signal) => {
        try {
          const result = await this.#callTool(session, name, args, signal);
          record('tool', name);
          return result;
        } catch (err) {
          record('tool', `${name} — ${toErr(err).message}`);
          throw err;
        }
      },
      requestApproval: async (summary, call, signal) => {
        const granted = await this.#requestApproval(session, summary, call, signal);
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
      this.#log.error('runtime prompt failed', { sessionId: session.id, err, data: { promptId: frame.id } });
      this.#sendSession(session, {
        t: 'done',
        s: session.id,
        promptId: frame.id,
        stopReason: 'error',
        error: toErr(err).message,
      });
    } finally {
      session.prompts.delete(frame.id);
    }
  }

  async #callTool(
    session: SessionState,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const tool = session.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool "${name}" is not in this session's grant`);
    if (session.grant.expiresAt <= Date.now()) throw new Error('capability grant expired');

    // Only the code-carrying fallback lacks browser consent and moves this
    // gate to the daemon. A delegated session was authorised for this exact
    // surface in the wallet-origin popup; subsequent approvals therefore go
    // to its CLIENT panel, which is the consent boundary that replaces the
    // viaConnect terminal gate.
    if (session.viaConnect && (tool.requiresApproval || session.grant.alwaysAsk.includes(name))) {
      const approved = await (this.#options.onLocalApproval?.(`Run ${name}`, { name, arguments: args }) ??
        Promise.resolve(false));
      if (!approved) throw new Error('declined by owner');
    }

    const id = randomId('call_');
    const deferred = new Deferred<unknown>();
    session.toolCalls.set(id, deferred);
    const abort = () => {
      if (!session.toolCalls.delete(id)) return;
      deferred.reject(signal?.reason instanceof Error ? signal.reason : new Error('tool call cancelled'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!signal?.aborted) this.#sendSession(session, { t: 'tool.call', s: session.id, id, name, arguments: args });
    return deferred.promise.finally(() => signal?.removeEventListener('abort', abort));
  }

  #requestApproval(
    session: SessionState,
    summary: string,
    call?: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<boolean> {
    // The code-carrying fallback has not been authorised by a browser wallet,
    // so its questions stay with the daemon owner. Delegated sessions are the
    // opposite: the hosted-wallet popup authorised this exact client surface,
    // and the real approval UI is in that client's panel, not onLocalApproval.
    if (session.viaConnect) {
      const ask = this.#options.onLocalApproval;
      if (!ask) return Promise.resolve(false);
      return ask(summary, call);
    }

    const id = randomId('appr_');
    const deferred = new Deferred<boolean>();
    session.approvals.set(id, deferred);
    const abort = () => {
      if (!session.approvals.delete(id)) return;
      deferred.resolve(false);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!signal?.aborted) {
      this.#sendSession(session, { t: 'approval.request', s: session.id, id, summary, ...(call ? { call } : {}) });
    }
    return deferred.promise.finally(() => signal?.removeEventListener('abort', abort));
  }

  #cancelInFlight(session: SessionState, reason: string): void {
    for (const controller of session.prompts.values()) controller.abort();
    for (const pending of session.toolCalls.values()) pending.reject(new Error(reason));
    session.toolCalls.clear();
    for (const pending of session.approvals.values()) pending.resolve(false);
    session.approvals.clear();
  }

  async #closeSession(session: SessionState, reason: string, notify = true): Promise<void> {
    this.#cancelInFlight(session, 'session closed');
    try {
      await session.runtime.closeSession?.();
    } catch (err) {
      this.#log.error('runtime failed to close session', { sessionId: session.id, err, data: { reason } });
    } finally {
      this.#sessions.delete(session.id);
      if (notify) this.#send({ t: 'session.close', s: session.id, reason });
      this.#log.info('session closed', { sessionId: session.id, data: { reason } });
    }
  }
}
