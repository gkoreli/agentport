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
  isSessionFrame,
  openSealed,
  openProofBinding,
  publicKeyOf,
  randomId,
  seal,
  sign,
  signCert,
  signEpk,
  resumeProofBinding,
  verifyEpk,
  type AgentCert,
  type AgentSummary,
  type CapabilityGrant,
  type Frame,
  type Hex,
  type Logger,
  type LogSink,
  type SessionFrame,
  type SealChannel,
  type SurfaceDescriptor,
} from '@agentport/protocol';
import { AgentSession, type ApprovalDecider, type SiteTool } from './session.js';
import { OPEN, defaultSocketFactory, type SocketFactory, type WebSocketLike } from './socket.js';

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

/** Frames an agent may legitimately put inside a sealed envelope. */
const AGENT_SEALABLE = new Set<string>(['delta', 'thought', 'done', 'tool.call', 'approval.request', 'history']);

/**
 * A resume refusal with the relay's reason attached, so callers can tell a
 * dead session ('not_resumable', 'grant_expired') from a transient race
 * ('already_attached': the old tab's socket close has not reached the relay
 * yet). Deleting a resume record over a transient reason turns a lost race
 * into a permanently lost session — the exact bug this type exists to stop.
 */
export class ResumeError extends Error {
  constructor(readonly reason: string) {
    super(`could not resume: ${reason}`);
  }
}

export interface WalletOptions {
  relayUrl: string;
  /** The user's root key. In production this is a passkey-backed or NIP-46 key. */
  userSecretKey: Hex;
  socketFactory?: SocketFactory;
  sink?: LogSink;
}

export interface SessionRequest {
  agent: Hex;
  surface: Omit<SurfaceDescriptor, 'origin'> & { origin?: string };
  tools: SiteTool[];
  /** Tool names that must be approved on every single invocation. */
  alwaysAsk?: string[];
  ttlMs?: number;
  decide?: ApprovalDecider;
}

export interface PairOffer {
  code: string;
  agent: { pubkey: Hex; name: string; runtime: string; location?: string };
}

type WalletEvents = {
  presence: { agent: Hex; online: boolean };
  closed: undefined;
};

/**
 * The wallet: holds the user key, knows which agents the user owns, and mints
 * capability-scoped sessions for a surface.
 *
 * In a shipped product this lives in a browser extension or a companion app,
 * not in the page. The page only ever touches `AgentSession`.
 */
export class AgentWallet extends Emitter<WalletEvents> {
  readonly publicKey: Hex;

  #options: WalletOptions;
  #socket: WebSocketLike | undefined;
  #sessions = new Map<string, AgentSession>();
  #waiters = new Map<string, Deferred<Frame>[]>();
  #resumeTokens = new Map<string, string>();
  /** Per-attachment symmetric keys; the relay never holds these (ADR-003). */
  #sealChannels = new Map<string, SealChannel>();
  #verifyWords = new Map<string, string>();
  /** The agent behind each session — resume routes by it (stateless relay). */
  #agentKeys = new Map<string, Hex>();
  #ready = new Deferred<void>();
  #log: Logger;

  constructor(options: WalletOptions) {
    super();
    this.#options = options;
    this.publicKey = publicKeyOf(options.userSecretKey);
    this.#log = createLogger('client.wallet', { sink: options.sink });
  }

  async connect(): Promise<void> {
    const factory = this.#options.socketFactory ?? defaultSocketFactory;
    const socket = factory(this.#options.relayUrl);
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#sendRaw({ t: 'hello', v: PROTOCOL_VERSION, role: 'client' });
    });
    socket.addEventListener('message', (event) => {
      let frame: Frame;
      try {
        frame = decodeFrame(String(event.data));
      } catch (err) {
        // Never silent: an undecodable frame means the peer and we disagree
        // about the protocol, which is exactly when you need to be told.
        this.#log.warn('dropped undecodable frame', { err, data: { relayUrl: this.#options.relayUrl } });
        return;
      }
      void this.#onFrame(frame).catch((err: unknown) => {
        this.#log.error('failed to handle relay frame', {
          err,
          ...(isSessionFrame(frame) ? { sessionId: frame.s } : {}),
          data: { frameType: frame.t, relayUrl: this.#options.relayUrl },
        });
      });
    });
    socket.addEventListener('close', () => this.emit('closed', undefined));
    // A WebSocket 'error' event carries no message; rejecting with the raw
    // Event is how "[object Event]" ends up in user-facing status lines.
    socket.addEventListener('error', () => {
      const err = new Error(`could not reach the relay at ${this.#options.relayUrl}`);
      this.#log.error('relay socket error', { err, data: { relayUrl: this.#options.relayUrl } });
      this.#ready.reject(err);
    });

    return this.#ready.promise;
  }

  /** Graceful shutdown: ends every session, then disconnects. */
  close(): void {
    for (const session of this.#sessions.values()) session.close('wallet_closed');
    this.#socket?.close();
  }

  /**
   * Drop the socket WITHOUT ending sessions — what a page refresh or a killed
   * tab actually looks like. The relay holds the session open for a grace
   * period so the reloaded page can resume it.
   */
  disconnect(): void {
    this.#socket?.close();
  }

  // --- directory -----------------------------------------------------------

  async listAgents(): Promise<AgentSummary[]> {
    this.#sendRaw({ t: 'agents.list' });
    const frame = await this.#await('agents');
    return (frame as Extract<Frame, { t: 'agents' }>).agents;
  }

  // --- pairing -------------------------------------------------------------

  /** Step 1: look up a code the user typed or opened. Nothing is signed yet. */
  async claimPairing(code: string): Promise<PairOffer> {
    this.#sendRaw({ t: 'pair.claim', code });
    const frame = (await this.#await('pair.offer')) as Extract<Frame, { t: 'pair.offer' }>;
    return { code: frame.code, agent: frame.agent };
  }

  /** Step 2: the user approves, so the wallet signs the ownership cert. */
  async approvePairing(offer: PairOffer, overrides: { name?: string } = {}): Promise<AgentCert> {
    const cert = signCert(this.#options.userSecretKey, {
      user: this.publicKey,
      agent: offer.agent.pubkey,
      name: overrides.name ?? offer.agent.name,
      runtime: offer.agent.runtime,
      location: offer.agent.location,
      issuedAt: Date.now(),
    });
    this.#sendRaw({ t: 'pair.complete', code: offer.code, cert });
    await this.#await('pair.bound');
    return cert;
  }

  // --- drop-in connect -----------------------------------------------------

  /**
   * Ask *some* agent for a session, without holding a key that names one.
   *
   * This is what `connect.js` uses. The wallet here is ephemeral and has no
   * certs, so it cannot list agents and cannot open a session directly — it
   * publishes a request and waits for its owner to accept it somewhere the
   * key actually lives. That asymmetry is the entire security argument for
   * letting a random site embed this.
   */
  async beginConnect(request: Omit<SessionRequest, 'agent'>): Promise<{
    code: string;
    expiresAt: number;
    accepted: Promise<AgentSession>;
  }> {
    const surface: SurfaceDescriptor = {
      ...request.surface,
      origin: request.surface.origin ?? globalThis.location?.origin ?? 'app://local',
    };
    const grant = {
      tools: request.tools.map(({ handler: _handler, ...definition }) => definition),
      alwaysAsk: request.alwaysAsk ?? [],
      expiresAt: Date.now() + (request.ttlMs ?? DEFAULT_SESSION_TTL_MS),
    };

    // The sealing keypair is minted before the code even exists; its proof is
    // scoped 'connect' because no session id exists yet. The daemon shows the
    // fingerprint over this key on its consent screen.
    const sealPair = generateSealKeyPair();
    this.#sendRaw({
      t: 'connect.begin',
      surface,
      grant,
      epk: sealPair.publicKey,
      epkSig: signEpk(
        this.#options.userSecretKey,
        'connect',
        sealPair.publicKey,
        openProofBinding('connect', surface, grant),
      ),
    });
    const pending = (await this.#await('connect.pending')) as Extract<Frame, { t: 'connect.pending' }>;

    const accepted = (async () => {
      const reply = await this.#await('session.opened', 'connect.denied');
      if (reply.t === 'connect.denied') {
        throw new Error(`connection declined: ${(reply as { reason: string }).reason}`);
      }
      const opened = reply as Extract<Frame, { t: 'session.opened' }>;
      if (opened.resume) this.#resumeTokens.set(opened.s, opened.resume);
      this.#establishSeal(
        opened.s,
        sealPair,
        opened,
        undefined,
        answerProofBinding('connect', this.publicKey, sealPair.publicKey, surface, grant, {
          agentName: opened.agentName,
          runtime: opened.runtime,
          resume: opened.resume,
        }),
      );
      if (opened.agent) this.#agentKeys.set(opened.s, opened.agent);
      return this.#makeSession(opened.s, surface, grant, opened, request);
    })();

    return { code: pending.code, expiresAt: pending.expiresAt, accepted };
  }

  /**
   * Re-attach to a session this origin already established — the page-refresh
   * path. The token was issued to this client alone and dies with the session.
   */
  async resumeSession(request: {
    id: string;
    /** The agent the session lives on — from the caller's resume record. */
    agent: Hex;
    token: string;
    tools: SiteTool[];
    decide?: ApprovalDecider;
  }): Promise<{ session: AgentSession; missed: number }> {
    // A real page refresh fires this while the OLD tab's socket close is
    // still in flight to the relay, which then refuses with already_attached
    // (correctly: a live session must not be stealable even with the token).
    // That race resolves itself within a second, so retry it here — every
    // caller (site, extension) gets refresh-resume without knowing why.
    let last: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.#attemptResume(request);
      } catch (err) {
        if (err instanceof ResumeError && err.reason === 'already_attached') {
          last = err;
          await new Promise((resolve) => setTimeout(resolve, 700));
          continue;
        }
        throw err;
      }
    }
    throw last as Error;
  }

  async #attemptResume(request: {
    id: string;
    agent: Hex;
    token: string;
    tools: SiteTool[];
    decide?: ApprovalDecider;
  }): Promise<{ session: AgentSession; missed: number }> {
    const sealPair = generateSealKeyPair();
    const resumedReply = this.#request('session.resumed', 'session.denied');
    try {
      this.#sendRaw({
        t: 'session.resume',
        s: request.id,
        agent: request.agent,
        token: request.token,
        epk: sealPair.publicKey,
        epkSig: signEpk(
          this.#options.userSecretKey,
          request.id,
          sealPair.publicKey,
          resumeProofBinding(request.agent, request.token),
        ),
      });
      const reply = await resumedReply.promise;
      if (reply.t === 'session.denied') {
        throw new ResumeError((reply as { reason: string }).reason);
      }
      // The DAEMON answers a resume (stateless relay), and its answer carries
      // its fresh epk — one round trip, one frame, no separate rekey step.
      const resumed = reply as Extract<Frame, { t: 'session.resumed' }>;
      this.#establishSeal(
        request.id,
        sealPair,
        resumed,
        request.agent,
        answerProofBinding('resume', this.publicKey, sealPair.publicKey, resumed.surface, resumed.grant, {
          agentName: resumed.agentName,
          runtime: resumed.runtime,
          missed: resumed.missed,
        }),
      );
      this.#agentKeys.set(request.id, request.agent);
      const session = this.#makeSession(
        resumed.s,
        resumed.surface,
        resumed.grant,
        { agentName: resumed.agentName, runtime: resumed.runtime },
        request,
      );
      return { session, missed: resumed.missed };
    } finally {
      resumedReply.cancel();
    }
  }

  // --- sessions ------------------------------------------------------------

  async openSession(request: SessionRequest): Promise<AgentSession> {
    const id = randomId('sess_');
    const surface: SurfaceDescriptor = {
      ...request.surface,
      origin: request.surface.origin ?? globalThis.location?.origin ?? 'app://local',
    };
    const grant = {
      tools: request.tools.map(({ handler: _handler, ...definition }) => definition),
      alwaysAsk: request.alwaysAsk ?? [],
      expiresAt: Date.now() + (request.ttlMs ?? DEFAULT_SESSION_TTL_MS),
    };

    const sealPair = generateSealKeyPair();
    this.#sendRaw({
      t: 'session.open',
      s: id,
      agent: request.agent,
      surface,
      grant,
      epk: sealPair.publicKey,
      epkSig: signEpk(
        this.#options.userSecretKey,
        id,
        sealPair.publicKey,
        openProofBinding('open', surface, grant, request.agent),
      ),
    });
    const reply = await this.#await('session.opened', 'session.denied');
    if (reply.t === 'session.denied') {
      throw new Error(`agent refused the session: ${(reply as { reason: string }).reason}`);
    }
    const opened = reply as Extract<Frame, { t: 'session.opened' }>;
    if (opened.resume) this.#resumeTokens.set(id, opened.resume);
    // A paired wallet knows exactly which agent it called, so the epk proof is
    // checked against the cert's key — the relay cannot substitute anything.
    this.#establishSeal(
      id,
      sealPair,
      opened,
      request.agent,
      answerProofBinding('open', this.publicKey, sealPair.publicKey, surface, grant, {
        agentName: opened.agentName,
        runtime: opened.runtime,
        resume: opened.resume,
      }),
    );
    this.#agentKeys.set(id, request.agent);

    return this.#makeSession(id, surface, grant, opened, request);
  }

  /**
   * The resume token the relay issued for a session, if any. Held in memory
   * only — deciding whether to persist it, and where, is the caller's call.
   */
  resumeTokenFor(sessionId: string): string | undefined {
    return this.#resumeTokens.get(sessionId);
  }

  /** Fingerprint words for a sealed session — show them; humans are the MITM check. */
  verifyWordsFor(sessionId: string): string | undefined {
    return this.#verifyWords.get(sessionId);
  }

  /**
   * The agent a session lives on. A resume record must carry this: the relay
   * is stateless, so the resume frame itself has to say where to go.
   */
  agentKeyFor(sessionId: string): Hex | undefined {
    return this.#agentKeys.get(sessionId);
  }

  /**
   * Verify the peer's epk proof and derive this attachment's key. When
   * `expectedAgent` is set (paired flow) the proof MUST verify against that
   * key. In the drop-in flow the agent identity arrives relay-stamped, so
   * first contact is TOFU — which is exactly what the fingerprint words on
   * the two consent surfaces exist to close.
   */
  #establishSeal(
    sessionId: string,
    sealPair: { publicKey: Hex; secretKey: Hex },
    reply: { epk?: Hex; epkSig?: Hex; agent?: Hex },
    expectedAgent: Hex | undefined,
    answerBinding: unknown,
  ): void {
    if (!reply.epk || !reply.epkSig) {
      throw new Error('agent omitted its sealing-key proof — refusing plaintext session');
    }
    const verifier = expectedAgent ?? reply.agent;
    if (!verifier || !verifyEpk(verifier, sessionId, reply.epk, reply.epkSig, answerBinding)) {
      throw new Error('agent sealing-key proof failed — aborting session');
    }
    this.#sealChannels.set(sessionId, deriveSealChannel(sealPair.secretKey, reply.epk, sessionId, 'client'));
    this.#verifyWords.set(sessionId, fingerprintWords(sealPair.publicKey, reply.epk));
  }

  #makeSession(
    id: string,
    surface: SurfaceDescriptor,
    grant: CapabilityGrant,
    opened: { agentName: string; runtime: string },
    request: { tools: SiteTool[]; decide?: ApprovalDecider },
  ): AgentSession {
    const session = new AgentSession({
      id,
      surface,
      grant,
      info: { agentName: opened.agentName, runtime: opened.runtime, verify: this.#verifyWords.get(id) },
      tools: request.tools,
      decide: request.decide ?? (() => false),
      logger: this.#log.child('session'),
      send: (frame: SessionFrame) => this.#sendSession(frame),
    });
    session.on('closed', () => {
      this.#sessions.delete(id);
      this.#sealChannels.delete(id);
      this.#verifyWords.delete(id);
      this.#agentKeys.delete(id);
    });
    this.#sessions.set(id, session);
    this.#log.info('session opened', { sessionId: id, data: { agentName: opened.agentName } });
    return session;
  }

  // -------------------------------------------------------------------------

  #sendRaw(frame: Frame): void {
    if (this.#socket && this.#socket.readyState === OPEN) this.#socket.send(encodeFrame(frame));
  }

  /** Session content leaves sealed whenever the attachment has a key. */
  #sendSession(frame: SessionFrame): void {
    if (!SEALED_TYPES.has(frame.t)) {
      this.#sendRaw(frame);
      return;
    }
    const channel = this.#sealChannels.get(frame.s);
    if (!channel) throw new Error(`refusing to send ${frame.t} without a sealing channel`);
    this.#sendRaw(seal(channel.send, frame));
  }

  async #onFrame(frame: Frame, openedFromSeal = false): Promise<void> {
    if (SEALED_TYPES.has(frame.t) && !openedFromSeal) {
      this.#log.warn('dropped plaintext session content', { sessionId: 's' in frame ? frame.s : undefined, data: { type: frame.t } });
      return;
    }
    if (frame.t === 'challenge') {
      this.#sendRaw({
        t: 'identify',
        pubkey: this.publicKey,
        sig: sign(this.#options.userSecretKey, authChallengeMessage(frame.nonce)),
      });
      return;
    }
    if (frame.t === 'ready') {
      this.#ready.resolve();
      return;
    }
    if (frame.t === 'agents.presence') {
      this.emit('presence', { agent: frame.agent, online: frame.online });
      return;
    }

    if (frame.t === 'enc') {
      const channel = this.#sealChannels.get(frame.s);
      if (!channel) {
        this.#log.warn('dropping sealed frame because the session has no channel', { sessionId: frame.s });
        return;
      }
      let inner: SessionFrame;
      try {
        inner = openSealed(channel.receive, frame);
      } catch (err) {
        this.#log.warn('failed to open sealed frame', { sessionId: frame.s, err });
        return;
      }
      // The relay cannot check inner types anymore; the origination rule it
      // used to enforce is applied here instead.
      if (!AGENT_SEALABLE.has(inner.t)) {
        this.#log.warn('agent sealed a frame it may not originate; dropping it', {
          sessionId: frame.s,
          data: { frameType: inner.t },
        });
        return;
      }
      await this.#onFrame(inner, true);
      return;
    }

    // These answer a pending request rather than an existing session —
    // routing them by session id drops them, because the session does not
    // exist on this side yet.
    const ANSWERS_A_REQUEST =
      frame.t === 'session.opened' || frame.t === 'session.denied' || frame.t === 'session.resumed';
    if (isSessionFrame(frame) && !ANSWERS_A_REQUEST) {
      await this.#sessions.get(frame.s)?.handle(frame);
      return;
    }

    if (this.#resolve(frame)) return;
    if (frame.t === 'error') {
      this.#log.error('relay rejected a frame', { data: { code: frame.code, message: frame.message } });
    }
  }

  /** Single-shot request/response correlation by frame type. */
  #await(...types: string[]): Promise<Frame> {
    return this.#request(...types).promise;
  }

  /** Like #await, but cancellable: a failed attempt must withdraw its waiter
   * or the leftover deferred swallows the reply meant for the retry. */
  #request(...types: string[]): { promise: Promise<Frame>; cancel: () => void } {
    const deferred = new Deferred<Frame>();
    for (const type of types) {
      const list = this.#waiters.get(type) ?? [];
      list.push(deferred);
      this.#waiters.set(type, list);
    }
    const cancel = () => {
      for (const [, list] of this.#waiters) {
        const index = list.indexOf(deferred);
        if (index >= 0) list.splice(index, 1);
      }
    };
    return { promise: deferred.promise, cancel };
  }

  #resolve(frame: Frame): boolean {
    const list = this.#waiters.get(frame.t);
    const deferred = list?.shift();
    if (!deferred) {
      // An error frame with no matching waiter still fails the oldest request.
      if (frame.t === 'error') {
        for (const [, queue] of this.#waiters) {
          const pending = queue.shift();
          if (pending) {
            pending.reject(new Error(`${frame.code}: ${frame.message}`));
            return true;
          }
        }
      }
      return false;
    }
    deferred.resolve(frame);
    return true;
  }
}
