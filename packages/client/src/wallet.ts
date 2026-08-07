import {
  Deferred,
  Emitter,
  PROTOCOL_VERSION,
  SEALED_TYPES,
  NonceMismatchError,
  WireViolation,
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
  CapabilityGrant,
  type Frame,
  type FrameType,
  type Hex,
  type Logger,
  type LogSink,
  type SessionFrame,
  type SealChannel,
  type SessionDelegation,
  SurfaceDescriptor,
} from '@agentport/protocol';
import { AgentSession, type ApprovalDecider, type SiteTool } from './session.js';
import { OPEN, defaultSocketFactory, type SocketFactory, type WebSocketLike } from './socket.js';

const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

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
  /**
   * How long a machine-speed handshake (open/resume) may wait for its answer.
   * Strict decode drops a mangled reply instead of throwing, so without this
   * the open promise would hang forever on a broken or hostile relay. Human
   * waits (drop-in connect approval) are deliberately not covered.
   */
  handshakeTimeoutMs?: number;
}

/**
 * Reconnect timing. These bound this client's *behavior*, not what the wire
 * will accept, which is why they live here and not in the protocol's
 * limits.ts: no peer validates them.
 *
 * The backoff is capped well under the relay's orphan grace, because a
 * reconnect that arrives after the daemon has released the session cannot
 * resume it — it would silently become a *new* attachment with a fresh grant
 * the user never approved. Giving up loudly is the honest end state.
 */
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 15_000;
const RECONNECT_MAX_ATTEMPTS = 12;

/**
 * Which pending request a refusal answers when no waiter listed it.
 *
 * Keyed by the refusal, valued by the success replies whose requests it can be
 * answering — so a denial always settles something rather than being dropped
 * on the floor while its caller waits.
 *
 * Note what this is: a hand-maintained set, exactly the kind of thing that
 * produced the bug it exists to prevent. A future frame that refuses
 * something and is not listed here drops silently again, and the caller hangs
 * again. It cannot be made total — the thing it is total OVER is "frames that
 * mean refusal", which is a judgement, not a type. So this closes one class,
 * and the general answer is the other one: every machine-speed round trip
 * gets a deadline, which turns silence into a visible failure even for the
 * cases nobody enumerated.
 */
const DENIAL_ANSWERS: Record<string, readonly string[] | undefined> = {
  'session.denied': ['session.opened', 'session.resumed'],
  'connect.denied': ['session.opened'],
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;

export interface SessionRequest {
  agent: Hex;
  /**
   * Hosted-wallet approval artifact: the user-signed delegation and the exact
   * grant whose hash it signs. When present, that frozen grant is sent verbatim
   * (`alwaysAsk`/`ttlMs` here are ignored) — rebuilding it would change
   * `expiresAt`, break the hash, and turn the approval into a dead signature.
   */
  approved?: { delegation: SessionDelegation; grant: CapabilityGrant };
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
  /** The socket dropped; a redial is scheduled. `attempt` starts at 1. */
  reconnecting: { attempt: number; delayMs: number };
  /** The socket is back and live sessions were re-established on it. */
  reconnected: { sessions: number; missed: number };
  closed: undefined;
};

/**
 * The page's tools and surface become protocol fields, so they are validated
 * HERE, where the site developer can act on the message — not on the far side
 * of the socket, where the same mistake shows up as a rejected frame and a
 * timed-out open. Throws a WireViolation naming the exact field.
 *
 * Exported because the hosted-wallet flow must build the grant BEFORE asking
 * for approval: the wallet signs its hash, so the same object — not an
 * equivalent one minted later — must reach `session.open`.
 */
export function buildGrant(request: Omit<SessionRequest, 'agent'>): CapabilityGrant {
  return CapabilityGrant(
    {
      tools: request.tools.map(({ handler: _handler, ...definition }) => definition),
      alwaysAsk: request.alwaysAsk ?? [],
      expiresAt: Date.now() + (request.ttlMs ?? DEFAULT_SESSION_TTL_MS),
    },
    'grant',
  );
}

function buildSurface(request: Omit<SessionRequest, 'agent'>): SurfaceDescriptor {
  return SurfaceDescriptor(
    {
      ...request.surface,
      origin: request.surface.origin ?? globalThis.location?.origin ?? 'app://local',
    },
    'surface',
  );
}

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
  /** Set by close()/disconnect(): an intentional teardown never redials. */
  #shutdown = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Tools and approval decider per session, so a reconnect can rebuild the
   *  attachment without asking the page to hand them over again. */
  #sessionRequests = new Map<string, { tools: SiteTool[]; decide?: ApprovalDecider }>();

  constructor(options: WalletOptions) {
    super();
    this.#options = options;
    this.publicKey = publicKeyOf(options.userSecretKey);
    this.#log = createLogger('client.wallet', { sink: options.sink });
  }

  async connect(): Promise<void> {
    this.#shutdown = false;
    this.#dial();
    return this.#ready.promise;
  }

  #dial(): void {
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
        // about the protocol, which is exactly when you need to be told. Only
        // the stable violation code and schema-defined path may be logged —
        // never bytes off the wire (ADR-019 §1).
        if (err instanceof WireViolation) {
          this.#log.warn('dropped invalid frame', { data: { code: err.code, path: err.path } });
        } else {
          this.#log.warn('dropped undecodable frame', { err, data: { relayUrl: this.#options.relayUrl } });
        }
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
    socket.addEventListener('close', () => {
      // Only THIS socket's death counts: a late close from a socket we already
      // replaced must not schedule a second redial chain.
      if (this.#socket !== socket) return;
      if (this.#shutdown) {
        this.emit('closed', undefined);
        return;
      }
      this.#scheduleReconnect();
    });
    // A WebSocket 'error' event carries no message; rejecting with the raw
    // Event is how "[object Event]" ends up in user-facing status lines.
    socket.addEventListener('error', () => {
      const err = new Error(`could not reach the relay at ${this.#options.relayUrl}`);
      this.#log.error('relay socket error', { err, data: { relayUrl: this.#options.relayUrl } });
      // Only fail the initial connect(): once a caller is past the handshake
      // the retry loop owns failures, and rejecting a settled deferred is a
      // no-op that would otherwise hide the reconnect from the log.
      if (this.#reconnectAttempt === 0) this.#ready.reject(err);
    });
  }

  /** Graceful shutdown: ends every session, then disconnects. */
  close(): void {
    this.#shutdown = true;
    clearTimeout(this.#reconnectTimer);
    for (const session of this.#sessions.values()) session.close('wallet_closed');
    this.#socket?.close();
  }

  /**
   * Redial after an unexpected close and put every live session back on the
   * new socket.
   *
   * This is the page-refresh path run without a page refresh. The relay holds
   * a dropped client's session for its orphan grace and the daemon owns the
   * resume authority (ADR-016), so the same token that survives a reload also
   * survives a sleeping laptop — the only thing missing was anyone trying.
   */
  #scheduleReconnect(): void {
    // There is exactly one reconnect implementation and no switch to turn it
    // off. The extension's service worker used to carry a second one; it was
    // deleted (e9f06d7) after it turned out to be not merely redundant but
    // harmful — its teardown sent session.close over the NEW socket, killing
    // the attachment it had just restored.
    if (this.#shutdown) return;
    if (this.#sessions.size === 0 && this.#reconnectAttempt === 0) {
      // Nothing to preserve and nothing in flight: report the close honestly
      // rather than holding a socket open for a wallet nobody is using.
      this.emit('closed', undefined);
      return;
    }
    if (this.#reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.#log.error('giving up on the relay; sessions are gone', {
        data: { attempts: this.#reconnectAttempt, relayUrl: this.#options.relayUrl },
      });
      for (const session of this.#sessions.values()) session.dropped('relay_unreachable');
      this.emit('closed', undefined);
      return;
    }
    const attempt = ++this.#reconnectAttempt;
    // Exponential with a cap. No jitter: this client dials one relay it is
    // already attached to, so there is no thundering herd to spread out, and a
    // deterministic delay is one less thing a flaky-reconnect bug can hide in.
    const delayMs = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), RECONNECT_MAX_DELAY_MS);
    this.#log.warn('relay socket dropped; redialling', {
      data: { attempt, delayMs, sessions: this.#sessions.size },
    });
    this.emit('reconnecting', { attempt, delayMs });
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = setTimeout(() => {
      this.#ready = new Deferred<void>();
      // A rejected handshake must not become an unhandled rejection: the retry
      // loop is what reacts to it, through the socket's own close event.
      this.#ready.promise.catch(() => {});
      this.#dial();
      void this.#ready.promise.then(
        () => this.#restoreSessions(),
        () => {},
      );
    }, delayMs);
  }

  /** Re-resume every live session on the fresh socket, in place. */
  async #restoreSessions(): Promise<void> {
    const live = [...this.#sessions.entries()];
    let restored = 0;
    let missedTotal = 0;
    for (const [id, session] of live) {
      const token = this.#resumeTokens.get(id);
      const agent = this.#agentKeys.get(id);
      const request = this.#sessionRequests.get(id);
      if (!token || !agent || !request) {
        // A session with no resume authority cannot come back; saying so is
        // better than leaving a handle that silently swallows prompts.
        session.dropped('not_resumable');
        continue;
      }
      try {
        const { missed } = await this.#attemptResume({ id, agent, token, ...request }, session);
        restored++;
        missedTotal += missed;
      } catch (err) {
        this.#log.warn('could not restore a session after reconnect', {
          sessionId: id,
          err,
          data: { relayUrl: this.#options.relayUrl },
        });
        session.dropped('resume_failed');
      }
    }
    this.#reconnectAttempt = 0;
    this.#log.info('relay reconnected', { data: { restored, missed: missedTotal } });
    this.emit('reconnected', { sessions: restored, missed: missedTotal });
  }

  /**
   * Drop the socket WITHOUT ending sessions — what a page refresh or a killed
   * tab actually looks like. The relay holds the session open for a grace
   * period so the reloaded page can resume it.
   */
  disconnect(): void {
    // Deliberately a shutdown: this models a tab going away, where the NEXT
    // page load resumes. Redialling here would race the reload for the same
    // session and lose (the relay refuses a second live attachment).
    this.#shutdown = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
  }

  // --- directory -----------------------------------------------------------

  async listAgents(): Promise<AgentSummary[]> {
    this.#sendRaw({ t: 'agents.list' });
    const frame = await this.#await('agents');
    return frame.agents;
  }

  /**
   * "This website may no longer use my agent" (ADR-022).
   *
   * Sendable only from the key the agent's cert names as its owner — the
   * relay refuses it from anyone else, and the daemon checks again. Returns
   * how many live attachments ended; the guarantee is the tombstone the
   * daemon recorded, not that number.
   */
  async revoke(agent: Hex, origin: string): Promise<number> {
    this.#sendRaw({ t: 'revoke', agent, origin });
    // Deadlined, like every other round-trip with no human in it. Withdrawing
    // authority is precisely the operation a user must not be left guessing
    // about: silence has to become a visible failure they can act on, not a
    // spinner. It is also the shape that makes a check on this path usable —
    // a test that hangs on the bug it targets is not a check, because a hang
    // is indistinguishable from slowness and nobody waits to find out.
    const frame = await this.#awaitTimed('revoke', 'revoked');
    return frame.sessions;
  }

  // --- pairing -------------------------------------------------------------

  /** Step 1: look up a code the user typed or opened. Nothing is signed yet. */
  async claimPairing(code: string): Promise<PairOffer> {
    this.#sendRaw({ t: 'pair.claim', code });
    const frame = await this.#await('pair.offer');
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
    const surface = buildSurface(request);
    const grant = buildGrant(request);

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
    const pending = await this.#await('connect.pending');

    const accepted = (async () => {
      // Three ways this ends, and every one of them must settle the promise.
      // `connect.denied` is the owner saying no at the code; `session.denied`
      // is the daemon refusing the open the relay synthesised after they said
      // yes — an expired approval, a revoked agent, an expired grant. That
      // second one used to be in nobody's waiter list, so the frame arrived,
      // #resolve found no queue for it, and the page waited forever on a
      // question that had already been answered. A refusal the caller never
      // hears is indistinguishable from a hang.
      const reply = await this.#await('session.opened', 'connect.denied', 'session.denied');
      if (reply.t === 'connect.denied' || reply.t === 'session.denied') {
        throw new Error(`connection declined: ${reply.reason}`);
      }
      const opened = reply;
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
          ownTools: opened.ownTools,
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

  /**
   * @param existing when a reconnect is restoring an attachment the page still
   * holds. The handle is rekeyed in place rather than replaced, because the
   * page's listeners are on the object it already has.
   */
  async #attemptResume(
    request: {
      id: string;
      agent: Hex;
      token: string;
      tools: SiteTool[];
      decide?: ApprovalDecider;
    },
    existing?: AgentSession,
  ): Promise<{ session: AgentSession; missed: number }> {
    const sealPair = generateSealKeyPair();
    const resumedReply = this.#request('session.resumed', 'session.denied');
    const ms = this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ResumeError(`session.resume handshake timed out after ${ms}ms`)), ms);
    });
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
      const reply = await Promise.race([resumedReply.promise, deadline]);
      if (reply.t === 'session.denied') {
        throw new ResumeError(reply.reason);
      }
      // The DAEMON answers a resume (stateless relay), and its answer carries
      // its fresh epk — one round trip, one frame, no separate rekey step.
      const resumed = reply;
      this.#establishSeal(
        request.id,
        sealPair,
        resumed,
        request.agent,
        answerProofBinding('resume', this.publicKey, sealPair.publicKey, resumed.surface, resumed.grant, {
          agentName: resumed.agentName,
          runtime: resumed.runtime,
          missed: resumed.missed,
          ownTools: resumed.ownTools,
        }),
      );
      this.#agentKeys.set(request.id, request.agent);
      if (existing) {
        existing.reattached({
          agentName: resumed.agentName,
          runtime: resumed.runtime,
          ownTools: resumed.ownTools,
          verify: this.#verifyWords.get(request.id),
        });
        return { session: existing, missed: resumed.missed };
      }
      const session = this.#makeSession(
        resumed.s,
        resumed.surface,
        resumed.grant,
        { agentName: resumed.agentName, runtime: resumed.runtime, ownTools: resumed.ownTools },
        request,
      );
      return { session, missed: resumed.missed };
    } finally {
      clearTimeout(timer);
      resumedReply.cancel();
    }
  }

  // --- sessions ------------------------------------------------------------

  async openSession(request: SessionRequest): Promise<AgentSession> {
    const id = randomId('sess_');
    const surface = buildSurface(request);
    const grant = request.approved?.grant ?? buildGrant(request);

    const sealPair = generateSealKeyPair();
    this.#sendRaw({
      t: 'session.open',
      s: id,
      agent: request.agent,
      ...(request.approved ? { delegation: request.approved.delegation } : {}),
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
    const reply = await this.#awaitTimed('session.open', 'session.opened', 'session.denied');
    if (reply.t === 'session.denied') {
      throw new Error(`agent refused the session: ${reply.reason}`);
    }
    const opened = reply;
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
        ownTools: opened.ownTools,
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
   *
   * `epk`/`epkSig` are required fields of the reply schemas, so a downgrade
   * attempt that strips them dies at decodeFrame ('missing_key') before this
   * runs — refusing plaintext is now a wire-validation property.
   */
  #establishSeal(
    sessionId: string,
    sealPair: { publicKey: Hex; secretKey: Hex },
    reply: { epk: Hex; epkSig: Hex; agent?: Hex },
    expectedAgent: Hex | undefined,
    answerBinding: unknown,
  ): void {
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
    opened: { agentName: string; runtime: string; ownTools: boolean },
    request: { tools: SiteTool[]; decide?: ApprovalDecider },
  ): AgentSession {
    const session = new AgentSession({
      id,
      surface,
      grant,
      info: {
        agentName: opened.agentName,
        runtime: opened.runtime,
        // Carried through from the daemon's signed answer, never guessed from
        // which tier this wallet thinks it is: the daemon is the party that
        // decides, and a second derivation here is exactly the drift the one
        // predicate exists to prevent.
        ownTools: opened.ownTools,
        verify: this.#verifyWords.get(id),
      },
      tools: request.tools,
      decide: request.decide ?? (() => false),
      logger: this.#log.child('session'),
      send: (frame: SessionFrame) => this.#sendSession(frame),
    });
    this.#sessionRequests.set(id, { tools: request.tools, decide: request.decide });
    session.on('closed', () => {
      this.#sessions.delete(id);
      this.#sessionRequests.delete(id);
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
        // openSealed enforces strict inner validation and the per-direction
        // sealable set ('agent' here) — the relay cannot, it sees ciphertext.
        inner = openSealed(channel.receive, frame, 'agent');
      } catch (err) {
        // Two failure classes (see openSealed). WireViolation: the agent
        // itself sealed an invalid or forbidden frame, or the channel can
        // never realign — session-fatal, and the close reason reaches the
        // page's 'closed' event (surfaced, not just logged). Plain decrypt
        // error: tampered or replayed input, not peer-authenticated, state
        // untouched — dropped, the session survives. Logs carry only the
        // stable code and schema path.
        if (!(err instanceof WireViolation)) {
          if (err instanceof NonceMismatchError) {
            this.#log.warn('dropped out-of-sequence sealed frame', { sessionId: frame.s });
          } else {
            this.#log.warn('failed to open sealed frame; dropping it', {
              sessionId: frame.s,
              data: { code: 'decrypt_failed' },
            });
          }
          return;
        }
        this.#log.error('sealed frame rejected; closing session', {
          sessionId: frame.s,
          data: { code: err.code, path: err.path },
        });
        const session = this.#sessions.get(frame.s);
        if (session) {
          session.close('seal_violation');
        } else {
          // A sealed frame raced the open handshake: no session exists to
          // close, so the dead channel state is discarded directly.
          this.#sealChannels.delete(frame.s);
          this.#verifyWords.delete(frame.s);
          this.#agentKeys.delete(frame.s);
        }
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

  /**
   * Single-shot request/response correlation by frame type. Always withdraws
   * BOTH queue entries once settled: a deferred registered under two types
   * and answered by one used to leave a stale twin that silently consumed the
   * next frame of the other type — an off-by-one that starved every waiter
   * behind it. Correlation waiters must never outlive their answer.
   */
  async #await<T extends FrameType>(...types: T[]): Promise<Extract<Frame, { t: T }>> {
    const request = this.#request(...types);
    try {
      return await request.promise;
    } finally {
      request.cancel();
    }
  }

  /**
   * #await with a deadline, for round-trips that involve no human: relay and
   * daemon answer at machine speed or something is wrong. The waiter is
   * withdrawn on timeout so it cannot swallow a late reply meant for a retry.
   */
  async #awaitTimed<T extends FrameType>(label: string, ...types: T[]): Promise<Extract<Frame, { t: T }>> {
    const request = this.#request(...types);
    const ms = this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} handshake timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([request.promise, deadline]);
    } finally {
      clearTimeout(timer);
      request.cancel();
    }
  }

  /** Like #await, but cancellable: a failed attempt must withdraw its waiter
   * or the leftover deferred swallows the reply meant for the retry. */
  #request<T extends FrameType>(...types: T[]): { promise: Promise<Extract<Frame, { t: T }>>; cancel: () => void } {
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
    // #resolve only settles a waiter with a decodeFrame-validated frame whose
    // `t` matched the type it was filed under, so this narrowing holds by
    // construction — it is what lets replies flow typed to every call site.
    return { promise: deferred.promise as Promise<Extract<Frame, { t: T }>>, cancel };
  }

  #resolve(frame: Frame): boolean {
    const list = this.#waiters.get(frame.t);
    const deferred = list?.shift();
    if (deferred) {
      deferred.resolve(frame);
      return true;
    }

    // An error frame with no matching waiter still fails the oldest request.
    if (frame.t === 'error') {
      for (const [, queue] of this.#waiters) {
        const pending = queue.shift();
        if (pending) {
          pending.reject(new Error(`${frame.code}: ${frame.message}`));
          return true;
        }
      }
      return false;
    }

    // A refusal nobody listed still answers the request it refuses.
    //
    // This is a backstop, not a second implementation of the waiter list: the
    // list still routes precisely, which matters when several opens are in
    // flight, because all this can do is fail the OLDEST request the refusal
    // could plausibly be answering. It buys liveness, not precision — and it
    // logs, so a list that needed it says so instead of silently working.
    //
    // Every waiter names the reply types it expects, per call — a set no
    // compiler can check is total, and forgetting the failure type is how a
    // page ends up waiting forever on a question that was already answered.
    // So the failure types do not depend on the list: a denial settles the
    // oldest request it could plausibly be answering, whether or not that
    // call site remembered to ask for it. The list is now an optimisation
    // for routing, not the thing standing between a caller and a hang.
    const refusal = frame.t === 'session.denied' || frame.t === 'connect.denied' ? frame : undefined;
    if (refusal) {
      for (const success of DENIAL_ANSWERS[refusal.t] ?? []) {
        const pending = this.#waiters.get(success)?.shift();
        if (pending) {
          this.#log.warn('a refusal was not in its waiter list; failing the request it answers', {
            data: { refusal: refusal.t, awaiting: success },
          });
          pending.reject(new Error(`connection declined: ${refusal.reason}`));
          return true;
        }
      }
    }
    return false;
  }
}
