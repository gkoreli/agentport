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
  isSessionFrame,
  openSealed,
  publicKeyOf,
  randomId,
  seal,
  sign,
  signCert,
  signEpk,
  verifyEpk,
  type AgentCert,
  type AgentSummary,
  type CapabilityGrant,
  type Frame,
  type Hex,
  type SessionFrame,
  type SurfaceDescriptor,
} from '@agentport/protocol';
import { AgentSession, type ApprovalDecider, type SiteTool } from './session.js';
import { OPEN, defaultSocketFactory, type SocketFactory, type WebSocketLike } from './socket.js';

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

/** Frames an agent may legitimately put inside a sealed envelope. */
const AGENT_SEALABLE = new Set<string>(['delta', 'thought', 'done', 'tool.call', 'approval.request', 'history']);

export interface WalletOptions {
  relayUrl: string;
  /** The user's root key. In production this is a passkey-backed or NIP-46 key. */
  userSecretKey: Hex;
  socketFactory?: SocketFactory;
  log?: (message: string) => void;
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
  #sealKeys = new Map<string, Uint8Array>();
  #verifyWords = new Map<string, string>();
  #ready = new Deferred<void>();
  #log: (message: string) => void;

  constructor(options: WalletOptions) {
    super();
    this.#options = options;
    this.publicKey = publicKeyOf(options.userSecretKey);
    this.#log = options.log ?? (() => {});
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
        this.#log(`dropped undecodable frame: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      void this.#onFrame(frame);
    });
    socket.addEventListener('close', () => this.emit('closed', undefined));
    // A WebSocket 'error' event carries no message; rejecting with the raw
    // Event is how "[object Event]" ends up in user-facing status lines.
    socket.addEventListener('error', () =>
      this.#ready.reject(new Error(`could not reach the relay at ${this.#options.relayUrl}`)),
    );

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
      epkSig: signEpk(this.#options.userSecretKey, 'connect', sealPair.publicKey),
    });
    const pending = (await this.#await('connect.pending')) as Extract<Frame, { t: 'connect.pending' }>;

    const accepted = (async () => {
      const reply = await this.#await('session.opened', 'connect.denied');
      if (reply.t === 'connect.denied') {
        throw new Error(`connection declined: ${(reply as { reason: string }).reason}`);
      }
      const opened = reply as Extract<Frame, { t: 'session.opened' }>;
      if (opened.resume) this.#resumeTokens.set(opened.s, opened.resume);
      this.#establishSeal(opened.s, sealPair, opened, undefined);
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
    token: string;
    tools: SiteTool[];
    decide?: ApprovalDecider;
    /**
     * Refuse to come back unsealed. Set when the original session was sealed:
     * a relay that "loses" the rekey answer must not be able to downgrade a
     * private session to plaintext by omission.
     */
    requireSealed?: boolean;
  }): Promise<{ session: AgentSession; missed: number }> {
    const sealPair = generateSealKeyPair();
    // Both replies race the round-trip, so both waiters exist BEFORE the send:
    // the daemon's rekey answer can beat the relay's own session.resumed.
    const resumedReply = this.#await('session.resumed', 'session.denied');
    const rekeyedReply = this.#await('session.rekeyed');
    this.#sendRaw({
      t: 'session.resume',
      s: request.id,
      token: request.token,
      epk: sealPair.publicKey,
      epkSig: signEpk(this.#options.userSecretKey, request.id, sealPair.publicKey),
    });
    const reply = await resumedReply;
    if (reply.t === 'session.denied') {
      throw new Error(`could not resume: ${(reply as { reason: string }).reason}`);
    }
    const resumed = reply as Extract<Frame, { t: 'session.resumed' }>;
    // Every attachment gets a fresh key: wait for the agent's answering epk so
    // the first history.request is already sealed. Bounded, because a daemon
    // running pre-sealing code will never answer — that degrades to plaintext
    // (loudly) unless the caller forbade it.
    const rekeyed = (await Promise.race([
      rekeyedReply,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
    ])) as Extract<Frame, { t: 'session.rekeyed' }> | null;
    if (rekeyed) {
      this.#establishSeal(request.id, sealPair, rekeyed, resumed.agent);
    } else if (request.requireSealed) {
      throw new Error('agent did not re-key within 5s — refusing to resume a sealed session in plaintext');
    } else {
      this.#log(`session ${request.id} resumed UNSEALED — the agent never re-keyed`);
    }
    const session = this.#makeSession(
      resumed.s,
      resumed.surface,
      resumed.grant,
      { agentName: resumed.agentName, runtime: resumed.runtime },
      request,
    );
    return { session, missed: resumed.missed };
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
      epkSig: signEpk(this.#options.userSecretKey, id, sealPair.publicKey),
    });
    const reply = await this.#await('session.opened', 'session.denied');
    if (reply.t === 'session.denied') {
      throw new Error(`agent refused the session: ${(reply as { reason: string }).reason}`);
    }
    const opened = reply as Extract<Frame, { t: 'session.opened' }>;
    if (opened.resume) this.#resumeTokens.set(id, opened.resume);
    // A paired wallet knows exactly which agent it called, so the epk proof is
    // checked against the cert's key — the relay cannot substitute anything.
    this.#establishSeal(id, sealPair, opened, request.agent);

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
  ): void {
    if (!reply.epk || !reply.epkSig) {
      this.#log(`session ${sessionId} is NOT sealed — peer sent no epk`);
      return;
    }
    const verifier = expectedAgent ?? reply.agent;
    if (!verifier || !verifyEpk(verifier, sessionId, reply.epk, reply.epkSig)) {
      throw new Error('agent epk proof failed — refusing to run the session unsealed');
    }
    this.#sealKeys.set(sessionId, deriveSealKey(sealPair.secretKey, reply.epk, sessionId));
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
      send: (frame: SessionFrame) => this.#sendSession(frame),
    });
    session.on('closed', () => {
      this.#sessions.delete(id);
      this.#sealKeys.delete(id);
      this.#verifyWords.delete(id);
    });
    this.#sessions.set(id, session);
    this.#log(`session ${id} open with ${opened.agentName}`);
    return session;
  }

  // -------------------------------------------------------------------------

  #sendRaw(frame: Frame): void {
    if (this.#socket && this.#socket.readyState === OPEN) this.#socket.send(encodeFrame(frame));
  }

  /** Session content leaves sealed whenever the attachment has a key. */
  #sendSession(frame: SessionFrame): void {
    const key = this.#sealKeys.get(frame.s);
    if (key && SEALED_TYPES.has(frame.t)) this.#sendRaw(seal(key, frame));
    else this.#sendRaw(frame);
  }

  async #onFrame(frame: Frame): Promise<void> {
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
      const key = this.#sealKeys.get(frame.s);
      if (!key) {
        this.#log(`sealed frame for ${frame.s} but no key — dropping`);
        return;
      }
      let inner: SessionFrame;
      try {
        inner = openSealed(key, frame);
      } catch (err) {
        this.#log(`failed to open sealed frame on ${frame.s}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      // The relay cannot check inner types anymore; the origination rule it
      // used to enforce is applied here instead.
      if (!AGENT_SEALABLE.has(inner.t)) {
        this.#log(`agent sealed a frame it may not originate (${inner.t}) — dropping`);
        return;
      }
      await this.#sessions.get(frame.s)?.handle(inner);
      return;
    }

    // These answer a pending request rather than an existing session —
    // routing them by session id drops them, because the session does not
    // exist on this side yet.
    const ANSWERS_A_REQUEST =
      frame.t === 'session.opened' ||
      frame.t === 'session.denied' ||
      frame.t === 'session.resumed' ||
      frame.t === 'session.rekeyed';
    if (isSessionFrame(frame) && !ANSWERS_A_REQUEST) {
      await this.#sessions.get(frame.s)?.handle(frame);
      return;
    }

    if (this.#resolve(frame)) return;
    if (frame.t === 'error') this.#log(`relay error ${frame.code}: ${frame.message}`);
  }

  /** Single-shot request/response correlation by frame type. */
  #await(...types: string[]): Promise<Frame> {
    const deferred = new Deferred<Frame>();
    for (const type of types) {
      const list = this.#waiters.get(type) ?? [];
      list.push(deferred);
      this.#waiters.set(type, list);
    }
    return deferred.promise;
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
