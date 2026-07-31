import {
  Deferred,
  Emitter,
  PROTOCOL_VERSION,
  authChallengeMessage,
  decodeFrame,
  encodeFrame,
  isSessionFrame,
  publicKeyOf,
  randomId,
  sign,
  signCert,
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
    socket.addEventListener('error', (err) => this.#ready.reject(err));

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

    this.#sendRaw({ t: 'connect.begin', surface, grant });
    const pending = (await this.#await('connect.pending')) as Extract<Frame, { t: 'connect.pending' }>;

    const accepted = (async () => {
      const reply = await this.#await('session.opened', 'connect.denied');
      if (reply.t === 'connect.denied') {
        throw new Error(`connection declined: ${(reply as { reason: string }).reason}`);
      }
      const opened = reply as Extract<Frame, { t: 'session.opened' }>;
      if (opened.resume) this.#resumeTokens.set(opened.s, opened.resume);
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
  }): Promise<{ session: AgentSession; missed: number }> {
    this.#sendRaw({ t: 'session.resume', s: request.id, token: request.token });
    const reply = await this.#await('session.resumed', 'session.denied');
    if (reply.t === 'session.denied') {
      throw new Error(`could not resume: ${(reply as { reason: string }).reason}`);
    }
    const resumed = reply as Extract<Frame, { t: 'session.resumed' }>;
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

    this.#sendRaw({ t: 'session.open', s: id, agent: request.agent, surface, grant });
    const reply = await this.#await('session.opened', 'session.denied');
    if (reply.t === 'session.denied') {
      throw new Error(`agent refused the session: ${(reply as { reason: string }).reason}`);
    }
    const opened = reply as Extract<Frame, { t: 'session.opened' }>;
    if (opened.resume) this.#resumeTokens.set(id, opened.resume);

    return this.#makeSession(id, surface, grant, opened, request);
  }

  /**
   * The resume token the relay issued for a session, if any. Held in memory
   * only — deciding whether to persist it, and where, is the caller's call.
   */
  resumeTokenFor(sessionId: string): string | undefined {
    return this.#resumeTokens.get(sessionId);
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
      info: { agentName: opened.agentName, runtime: opened.runtime },
      tools: request.tools,
      decide: request.decide ?? (() => false),
      send: (frame: SessionFrame) => this.#sendRaw(frame),
    });
    session.on('closed', () => this.#sessions.delete(id));
    this.#sessions.set(id, session);
    this.#log(`session ${id} open with ${opened.agentName}`);
    return session;
  }

  // -------------------------------------------------------------------------

  #sendRaw(frame: Frame): void {
    if (this.#socket && this.#socket.readyState === OPEN) this.#socket.send(encodeFrame(frame));
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

    // These three answer a pending request rather than an existing session —
    // routing them by session id drops them, because the session does not
    // exist on this side yet.
    const ANSWERS_A_REQUEST = frame.t === 'session.opened' || frame.t === 'session.denied' || frame.t === 'session.resumed';
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
