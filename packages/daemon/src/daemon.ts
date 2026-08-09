import { WebSocket } from 'ws';
import {
  Deferred,
  Emitter,
  MAX_DESCRIPTION_CHARS,
  MAX_ERROR_CHARS,
  MAX_FRAME_CHARS,
  MAX_HISTORY_ENTRIES,
  MAX_MISSED_COUNT,
  MAX_PLAN_STEPS,
  MAX_REASON_CHARS,
  MAX_SEALED_PLAINTEXT_BYTES,
  MAX_SESSIONS_REPORTED,
  MAX_TEXT_CHARS,
  PROTOCOL_VERSION,
  SEALED_TYPES,
  TIMESTAMP_MAX,
  TIMESTAMP_MIN,
  NonceMismatchError,
  WireViolation,
  answerProofBinding,
  authChallengeMessage,
  createLogger,
  decodeFrame,
  deriveSealChannel,
  encodeFrame,
  delegationLifetimeOk,
  fingerprintWords,
  generateSealKeyPair,
  hashCall,
  hashGrant,
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
  verifyCert,
  verifyDelegation,
  type AgentCert,
  type AuthorityDomain,
  type CapabilityGrant,
  type Frame,
  type HistoryEntry,
  type KeyPair,
  type Logger,
  type LogSink,
  type SessionFrame,
  type SealChannel,
  type SessionDelegation,
  type SurfaceDescriptor,
  type ToolDefinition,
} from '@agentport/protocol';
import type { AgentIdentity } from './identity.js';
import { isRevoked, memoryRevocations, type Revocation, type RevocationStore } from './revocations.js';
import {
  attachmentPolicy,
  type AskAnswers,
  type AskQuestion,
  type AgentRuntime,
  type AttachmentPolicy,
  type TurnContext,
} from './runtime.js';

interface SessionState {
  id: string;
  /** Came from a drop-in widget, so approvals belong here, not in the page. */
  viaConnect: boolean;
  /**
   * The hosted wallet's authority for this page identity, RETAINED rather
   * than collapsed to a boolean: resume must be able to re-judge it against
   * the revocation tombstones, and a resume presents only a bearer token, so
   * the delegation is the only thing left tying the attachment to an origin
   * the user may since have cut off (ADR-022 R4).
   */
  delegation?: SessionDelegation;
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  tools: ToolDefinition[];
  runtime: AgentRuntime;
  /**
   * Decided ONCE, when the attachment opens, and then both declared to the
   * runtime and enforced against. One object rather than a recomputation at
   * each use: what the agent was told it may do and what the daemon will
   * actually allow are then the same value, not two evaluations that have to
   * keep agreeing.
   */
  policy: AttachmentPolicy;
  /**
   * The conversation, recorded on the user's own machine. This is the
   * authoritative transcript: the relay stores none of it, and the website is
   * expected to keep none of it across a reload.
   */
  transcript: HistoryEntry[];
  toolCalls: Map<string, Deferred<unknown>>;
  approvals: Map<string, { decision: Deferred<boolean>; callHash?: string }>;
  asks: Map<string, Deferred<AskAnswers | undefined>>;
  prompts: Map<string, AbortController>;
  /** Symmetric key sealing this attachment's content frames (ADR-003). */
  sealChannel: SealChannel;
  /**
   * Session authority lives HERE (ADR-016): the daemon mints the resume
   * token, retains the client identity it was issued to, judges both on
   * resume, survives relay restarts, and counts what the client missed while
   * detached. The relay only ever routes.
   */
  resumeToken: string;
  /** Stable Ed25519 identity of this logical attachment, captured at open. */
  readonly clientKey: string;
  detachedAt?: number;
  missed: number;
  resumeAttempts: number;
}

/** How long a detached session is held for a client to come back. */
const DETACH_GRACE_MS = 30 * 60 * 1000;

/**
 * How long an approved-but-unredeemed connect offer stays redeemable. The
 * relay expires the connect code itself after three minutes, so an approval
 * outliving that by much is authority with nothing left to spend it on;
 * doubling it leaves room for a slow page without leaving a standing yes.
 */
const CONNECT_APPROVAL_TTL_MS = 6 * 60 * 1000;
const MAX_RESUME_ATTEMPTS = 10;

/**
 * How long the agent waits for its user to answer before proceeding as if
 * they skipped. Generous, because a human has to read a question and decide —
 * but finite, because a turn that waits forever on a dialog nobody is looking
 * at is the hang this whole design exists to avoid.
 */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How long `start()` waits for the relay to finish the handshake.
 *
 * The wallet has had this since it learned that a reachable-but-silent relay
 * hangs the last rung of the connect ladder; the daemon never got the same
 * treatment, and it is the side a stranger runs from a terminal. Without it a
 * relay that answers with a protocol error — a version mismatch, say — leaves
 * the process sitting forever after printing a perfectly good explanation of
 * why it cannot proceed. Tenet 3: a hang is indistinguishable from slowness,
 * and nobody waits to find out.
 */
const HANDSHAKE_TIMEOUT_MS = 20_000;

/**
 * Char budget for one history frame's entries. UTF-8 never exceeds 3 bytes
 * per UTF-16 code unit, so a char budget of bytes/3 cannot overflow the
 * sealed-plaintext byte bound however the text encodes; the subtraction
 * covers the frame envelope around the entries array.
 */
const HISTORY_BUDGET_CHARS = Math.floor(MAX_SEALED_PLAINTEXT_BYTES / 3) - 1024;

export interface DaemonOptions {
  relayUrl: string;
  identity: AgentIdentity;
  createRuntime: () => AgentRuntime;
  /** Called with the pairing code when the agent is not yet bound to a user. */
  onPairingCode?: (code: string, expiresAt: number) => void;
  /** Called once the user has signed a cert for this agent. */
  onBound?: (cert: AgentCert) => void;
  /**
   * The user unpaired: persist the identity WITHOUT its cert. The mirror of
   * `onBound`, and the reason the daemon still never learns where its own
   * identity file lives.
   */
  onUnbound?: () => void;
  /**
   * Durable "this origin may no longer use my agent" tombstones (ADR-022).
   * In-memory by default so an embedder or a test needs no filesystem; the
   * CLI passes `fileRevocations` beside the identity.
   */
  revocations?: RevocationStore;
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
  onLocalApproval?: (
    domain: AuthorityDomain,
    summary: string,
    call?: { name: string; arguments: Record<string, unknown> },
  ) => Promise<boolean>;
  /**
   * The agent is asking its user a question in a connect.js session (ADR-024).
   *
   * Supplying this is what GRANTS elicitation on the connect tier, rather than
   * merely routing it: that tier's client is a page key with no cert behind
   * it, so if the daemon cannot render the question itself there is nobody who
   * may answer it, and `mayAsk` stays false. An embedder with no terminal —
   * a test, a service — therefore gets the refusing behaviour by default
   * instead of silently forwarding the user's voice to the requesting page.
   *
   * Resolve `undefined` for "not answered"; every non-answer means the tool
   * proceeds without one rather than the turn dying.
   */
  onLocalAsk?: (question: AskQuestion) => Promise<AskAnswers | undefined>;
  /**
   * Test-only clock seam, as `RelayOptions.now` is. The approval window is
   * minutes long by design, and an expiry check that has to sleep for one is a
   * check nobody runs — so the only property here that cannot be observed
   * without it is the one that matters most.
   */
  now?: () => number;
  /**
   * Test seam, and the same name the wallet uses so there is one dialect for
   * "how long do we wait for a relay to say something".
   */
  handshakeTimeoutMs?: number;
  sink?: LogSink;
}

type DaemonEvents = {
  ready: { bound: boolean };
  bound: AgentCert;
  /** The user withdrew an origin's authority; `sessions` were ended. */
  revoked: { origin: string; sessions: number };
  /** The agent is no longer owned by anyone and accepts nothing. */
  unbound: undefined;
  session: string;
  closed: undefined;
};

export class AgentDaemon extends Emitter<DaemonEvents> {
  #options: DaemonOptions;
  #socket: WebSocket | undefined;
  #sessions = new Map<string, SessionState>();
  /**
   * Sealing keypairs minted at connect-offer time, keyed by the client epk,
   * with the moment they were approved.
   *
   * An approval the widget never redeemed used to sit here for the process's
   * lifetime: consent said yes, the session never opened, and the keypair
   * stayed redeemable. That is a standing "yes" for a decision the user made
   * once, minutes or days ago — and unlike a delegation it carries no origin,
   * so revoking an origin structurally cannot reach it (ADR-022). The
   * heartbeat expires it on the same schedule the relay expires the connect
   * code itself.
   */
  #offerSeals = new Map<string, { keys: KeyPair; at: number }>();
  #log: Logger;
  #readyDeferred = new Deferred<{ bound: boolean }>();
  #readyTimer: ReturnType<typeof setTimeout> | undefined;
  #authenticated = false;
  #stopped = false;
  #retryMs = 1000;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #revocations: RevocationStore;

  constructor(options: DaemonOptions) {
    super();
    this.#options = options;
    this.#log = createLogger('daemon', { sink: options.sink });
    this.#revocations = options.revocations ?? memoryRevocations();
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /**
   * The attachment may exercise only the intersection of its grant and the
   * outer delegation that authorised it. This is consulted on LIVE traffic,
   * not just open/resume: staying connected must not turn a short delegation
   * into a longer grant, and a tool result arriving after the boundary must
   * not complete work whose authority ended while it was in flight.
   */
  #authorityError(session: Pick<SessionState, 'grant' | 'delegation'>): Error | undefined {
    const now = this.#now();
    if (session.grant.expiresAt <= now) return new Error('capability grant expired');
    if (session.delegation && session.delegation.expiresAt <= now) {
      return new Error('delegation authorization expired');
    }
    return undefined;
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
    // Armed here rather than in `#dial`, because `#dial` also runs for every
    // later redial and those are the close handler's business, not the
    // caller's — `start()` has long since settled by then.
    const handshakeMs = this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.#readyTimer = setTimeout(() => {
      this.#failStart(new Error(`the relay did not finish the handshake within ${handshakeMs}ms`));
    }, handshakeMs);
    this.#dial();
    return this.#readyDeferred.promise;
  }

  /**
   * Settle a pending `start()` as failed, once.
   *
   * A no-op after the handshake succeeded: the Deferred is settle-once, so a
   * relay error arriving at a running daemon stays what it already was — a
   * logged frame, not a reason to tear anything down.
   */
  #failStart(err: Error): void {
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
    this.#readyDeferred.reject(err);
  }

  #dial(): void {
    if (this.#stopped) return;
    // maxPayload caps what a broken or hostile relay can buffer into daemon
    // memory before decodeFrame's own char bound runs (ws client default is
    // 100 MiB) — the same ceiling the relay itself enforces.
    const socket = new WebSocket(this.#options.relayUrl, { maxPayload: MAX_FRAME_CHARS });
    this.#socket = socket;

    socket.on('open', () => {
      this.#send({ t: 'hello', v: PROTOCOL_VERSION, role: 'agent' });
    });
    socket.on('message', (data, isBinary) => {
      // Text frames only — mirrors both relay hosts; binary has no meaning
      // in this protocol and stringifying it would invent one.
      if (isBinary) {
        this.#log.warn('dropped binary relay message', { data: { relayUrl: this.#options.relayUrl } });
        return;
      }
      let frame: Frame;
      try {
        frame = decodeFrame(data.toString());
      } catch (err) {
        // The relay already validates at origination, so this firing means a
        // broken or hostile relay — drop the frame as defense in depth. Only
        // the violation's stable code and schema path may be logged; the
        // frame's own bytes never appear anywhere (ADR-019 §1).
        if (err instanceof WireViolation) {
          this.#log.warn('dropped invalid relay frame', {
            data: { code: err.code, path: err.path, relayUrl: this.#options.relayUrl },
          });
        } else {
          this.#log.warn('dropped undecodable frame', { err, data: { relayUrl: this.#options.relayUrl } });
        }
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
      const staleOffer = this.#now() - CONNECT_APPROVAL_TTL_MS;
      for (const [epk, offer] of this.#offerSeals) {
        if (offer.at < staleOffer) this.#offerSeals.delete(epk);
      }
      const cutoff = this.#now() - DETACH_GRACE_MS;
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
      const now = this.#now();
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

  /**
   * What is attached right now, for `agentport status` and the wallet's
   * "origins holding your agent" view. Deliberately a projection, not the
   * live state: a caller gets no handle on a session, and no transcript.
   */
  attachments(): Attachment[] {
    return [...this.#sessions.values()].map((session) => ({
      id: session.id,
      origin: session.surface.origin,
      surface: session.surface.name,
      tools: session.grant.tools.length,
      grantExpiresAt: session.grant.expiresAt,
      delegated: session.delegation !== undefined,
      detachedAt: session.detachedAt,
    }));
  }

  /** Tombstones in force. Same projection reasoning as `attachments()`. */
  revocations(): readonly Revocation[] {
    return this.#revocations.list();
  }

  /**
   * Close every attachment a tombstone already covers.
   *
   * `agentport revoke` writes the tombstone durably and does not talk to this
   * process — the store re-reads the file, so open and resume are refused
   * immediately. But a session that is already live is not judged again until
   * it resumes, and ADR-022 R11 requires it to end. The daemon's existing
   * control poll calls this; it is idempotent, so a repeat costs nothing.
   */
  async enforceRevocations(): Promise<number> {
    const revocations = this.#revocations.list();
    if (revocations.length === 0) return 0;
    const doomed = [...this.#sessions.values()].filter(
      (session) => session.delegation && isRevoked(revocations, session.delegation),
    );
    for (const session of doomed) await this.#closeSession(session, 'revoked');
    if (doomed.length > 0) this.#log.info('closed revoked attachments', { data: { sessions: doomed.length } });
    return doomed.length;
  }

  /**
   * "This website may no longer use my agent" (ADR-022 R1/R2).
   *
   * Records the tombstone FIRST, then tears down. The order is the whole
   * point: between closing a session and writing the record there is a window
   * in which the page — which redials automatically — could resume or reopen
   * on the delegation it still holds. Recording first closes it.
   *
   * Returns how many live attachments ended. That number is feedback, never
   * authority: the guarantee is the tombstone, not the count.
   */
  async revoke(origin: string): Promise<number> {
    const at = this.#now();
    this.#revocations.add({ origin, at });

    const doomed = [...this.#sessions.values()].filter((session) => session.surface.origin === origin);
    for (const session of doomed) await this.#closeSession(session, 'revoked');

    this.#log.info('origin revoked', { data: { sessions: doomed.length } });
    this.emit('revoked', { origin, sessions: doomed.length });
    return doomed.length;
  }

  /**
   * The terminal verb (ADR-022 R6): this agent is no longer owned by anyone.
   *
   * Drops the cert, ends every attachment, and redials so the relay stops
   * announcing the agent and admits nobody toward it. Safe only because an
   * absent cert now means refuse-everything (R5) — on the old code path,
   * unpairing would have OPENED the daemon rather than closing it.
   */
  async unpair(): Promise<void> {
    delete this.#options.identity.cert;
    this.#options.onUnbound?.();

    for (const session of [...this.#sessions.values()]) await this.#closeSession(session, 'revoked');

    this.#log.info('agent unpaired');
    this.emit('unbound', undefined);
    // Re-identify without the cert. The socket close triggers the ordinary
    // redial path, which presents whatever identity we now hold.
    this.#socket?.close();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
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
      // Saturate: `missed` is routing metadata with a wire bound, and a
      // session.resumed carrying an out-of-domain count would be a frame we
      // could not legally send — turning a long detachment into a session
      // that can never be resumed at all.
      if (session.missed < MAX_MISSED_COUNT) session.missed++;
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
        clearTimeout(this.#readyTimer);
        this.#readyTimer = undefined;
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
        this.#offerSeals.set(frame.epk, { keys: mine, at: this.#now() });
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

      case 'pair.bound': {
        // An ownership claim is checked here, not taken on the relay's word.
        //
        // Already-bound is the load-bearing half. Anything that can reach the
        // daemon's pairing control — including the agent runtime, whose own
        // filesystem tools run in a directory beside it — can make the daemon
        // mint a pairing code, read it, and complete the pairing with ITS
        // user key. Without this guard that silently replaces the owner's
        // cert with the attacker's, and the real owner is locked out of their
        // own agent. Rebinding must be something the user chose: unpair
        // first, deliberately (ADR-022 R12).
        const current = this.#options.identity.cert;
        if (current) {
          this.#log.warn('pairing refused: this agent already has an owner');
          return;
        }
        if (frame.cert.agent !== this.#options.identity.publicKey || !verifyCert(frame.cert)) {
          this.#log.warn('pairing refused: cert does not bind this agent');
          return;
        }
        this.#options.identity.cert = frame.cert;
        this.#options.onBound?.(frame.cert);
        this.emit('bound', frame.cert);
        return;
      }

      case 'revoke':
        return this.#onRevoke(frame);

      case 'session.open':
        return this.#onSessionOpen(frame);

      case 'session.detach': {
        const session = this.#sessions.get(frame.s);
        if (session && session.detachedAt === undefined) {
          session.detachedAt = this.#now();
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
        if (!session) {
          this.#log.warn('dropping sealed frame for unknown session', { sessionId: frame.s });
          return;
        }
        let inner: SessionFrame;
        try {
          // openSealed owns the whole inner boundary (ADR-019 §1): plaintext
          // bound, strict inner-frame validation, the client-sealable set,
          // and the envelope/inner session-id match.
          inner = openSealed(session.sealChannel.receive, frame, 'client');
        } catch (err) {
          // Two failure classes (see openSealed). A WireViolation happened
          // AFTER authentication: the client itself sealed an invalid or
          // forbidden frame, or the channel skipped a frame it can never
          // recover — session-fatal. A plain decrypt error is tampered or
          // replayed input that the relay could have injected; state is
          // untouched, so the frame is dropped and the session survives.
          // Only the stable code and schema path are loggable — never nonce,
          // ciphertext, or plaintext bytes.
          if (err instanceof WireViolation) {
            this.#log.error('sealed frame rejected; closing session', {
              sessionId: frame.s,
              data: { code: err.code, path: err.path },
            });
            await this.#closeSession(session, 'seal_violation');
          } else if (err instanceof NonceMismatchError) {
            this.#log.warn('dropped out-of-sequence sealed frame', { sessionId: frame.s });
          } else {
            this.#log.warn('failed to open sealed frame; dropping it', {
              sessionId: frame.s,
              data: { code: 'decrypt_failed' },
            });
          }
          return;
        }
        return this.#onFrame(inner, true);
      }


      case 'session.close': {
        const session = this.#sessions.get(frame.s);
        // The client's own reason string is not re-sent (notify=false) and is
        // client-controlled, so it stays out of our logs too; the stable label
        // records who initiated the close.
        if (session) await this.#closeSession(session, 'client_closed', false);
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
        const bounded = this.#boundedHistory(frame.s, replayed ?? session.transcript);
        this.#sendSession(session, {
          t: 'history',
          s: frame.s,
          entries: bounded.entries,
          // Tell the client the transcript is partial rather than letting a
          // bounded replay masquerade as the whole conversation.
          ...(bounded.truncated ? { truncated: true } : {}),
        });
        return;
      }

      case 'prompt':
        return this.#onPrompt(frame);

      case 'prompt.cancel': {
        this.#sessions.get(frame.s)?.prompts.get(frame.id)?.abort();
        return;
      }

      case 'tool.result': {
        const session = this.#sessions.get(frame.s);
        if (!session) return;
        const pending = session.toolCalls.get(frame.id);
        if (!pending) return;
        session.toolCalls.delete(frame.id);
        const authorityError = this.#authorityError(session);
        if (authorityError) {
          this.#log.warn('refused a surface tool result after attachment authority expired', {
            sessionId: frame.s,
            data: { toolCallId: frame.id },
          });
          pending.reject(authorityError);
          return;
        }
        this.#log.info('surface tool result received', {
          sessionId: frame.s,
          data: { toolCallId: frame.id, ok: frame.ok },
        });
        if (frame.ok) pending.resolve(frame.result);
        else pending.reject(new Error(frame.error ?? 'tool call failed'));
        return;
      }

      case 'answer': {
        const session = this.#sessions.get(frame.s);
        const pending = session?.asks.get(frame.id);
        if (!session || !pending) return;
        // Delete before resolve, and let delete's result decide — same
        // interlock as the approval path, for the same reason.
        if (!session.asks.delete(frame.id)) return;
        if (frame.outcome === 'skipped') {
          pending.resolve(undefined);
          return;
        }
        // Object.create(null), not {}. `__proto__` satisfies ID_PATTERN, so it
        // is a legal field key on the wire — and assigning it onto an object
        // LITERAL hits the prototype setter, which ignores a string. The
        // answer would not be polluted; it would silently VANISH, and the
        // agent would be told the user left blank a field it explicitly asked
        // about. A null-prototype object has no such setter, so every key the
        // user answered arrives as the key they answered.
        const answers: AskAnswers = Object.create(null) as AskAnswers;
        for (const entry of frame.values ?? []) answers[entry.key] = entry.value;
        pending.resolve(answers);
        return;
      }

      case 'approval.response': {
        const pending = this.#sessions.get(frame.s)?.approvals.get(frame.id);
        if (!pending) return;
        // Delete BEFORE resolve, and let delete's own result be the interlock
        // (see the abort path). That ordering — not the id being unguessable —
        // is what makes a replayed response a no-op and stops a timeout racing
        // an answer into a double resolve. A refactor that resolves first, or
        // that keeps answered ids around for idempotency, kills the property
        // silently — and NOTHING asserts it. ADR-023 R9 records why: the nonce
        // guard makes wire duplication unreachable, so only a purpose-built
        // hostile peer could exercise this, and a check that cannot fail would
        // prove nothing. This ordering is protected by review alone. Do not
        // upgrade that sentence into a claim of coverage without adding the
        // harness that earns it.
        this.#sessions.get(frame.s)!.approvals.delete(frame.id);
        // The answer must be about the question (ADR-023 R6). A decision that
        // did not come from a human reading this exact call — a policy engine,
        // a remembered "yes" — cannot be replayed onto a different one.
        if (pending.callHash !== frame.callHash) {
          this.#log.warn('approval answered a different call than it asked about', {
            sessionId: frame.s,
          });
          pending.decision.resolve(false);
          return;
        }
        pending.decision.resolve(frame.granted);
        return;
      }

      case 'error':
        this.#log.error('relay rejected a frame', { data: { code: frame.code, message: frame.message } });
        // Before the handshake completes this is terminal for the caller, and
        // saying so is the whole point: the relay has just explained itself
        // ("relay speaks agentport/1"), and that explanation used to be
        // printed to a process which then waited forever. The message is
        // already good; it only needed to reach the exit.
        if (!this.#authenticated) {
          this.#failStart(new Error(`the relay refused this daemon: ${frame.code}${frame.message ? ` — ${frame.message}` : ''}`));
        }
        return;

      default:
        // Same rule as the client's router: partial on purpose, so the guard
        // is visibility rather than exhaustiveness. A frame that decoded,
        // unsealed and routed correctly and then matched nothing here is
        // dropped, and this is the only place that can say so.
        this.#log.warn('dropped a frame this daemon has no handler for', {
          data: { frameType: frame.t },
        });
        return;
    }
  }

  /**
   * The daemon rules on a resume: it minted the token, so only it can judge
   * one. One denial reason for anything unprovable — a wrong token must not
   * be distinguishable from a session that never existed — and a constant-time
   * compare so timing does not answer what the message will not.
   */
  /**
   * A revoke arriving over the wire. The relay already checked that the asker
   * owns this agent; the daemon checks it again against its own cert, because
   * invariant 6 says a lying relay must gain nothing — and here the prize
   * would be ending a stranger's attachments.
   *
   * A refusal is silent. There is nothing for a non-owner to learn from an
   * error, and the relay has already refused this on its own side.
   */
  async #onRevoke(frame: Extract<Frame, { t: 'revoke' }>): Promise<void> {
    const cert = this.#options.identity.cert;
    if (!cert || !frame.client || frame.client !== cert.user || frame.agent !== cert.agent) {
      this.#log.warn('revoke refused: not from the owner');
      return;
    }
    const sessions = await this.revoke(frame.origin);
    this.#send({
      t: 'revoked',
      agent: cert.agent,
      origin: frame.origin,
      sessions: Math.min(sessions, MAX_SESSIONS_REPORTED),
    });
  }

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
    // The token is visible to the relay, so it is necessary but never
    // sufficient resume authority. The resumer must also prove the SAME
    // Ed25519 attachment identity captured at open. Compare both before any
    // state changes, and use the same generic denial as an unknown session so
    // a wrong identity learns nothing from possession of an observed token.
    const tokenMatches = timingSafeEqualStr(session.resumeToken, frame.token);
    const clientMatches = typeof frame.client === 'string' && timingSafeEqualStr(session.clientKey, frame.client);
    if (!tokenMatches || !clientMatches) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'not_resumable' });
      return;
    }
    // A malicious relay may stamp the stored public key without possessing
    // it. Prove that identity before returning lifecycle-specific reasons:
    // only the original attachment may learn whether it is still attached,
    // expired, or revoked. The fresh EPK remains mandatory, so replaying an
    // old signed resume cannot make the relay an endpoint it can decrypt.
    if (
      !frame.epk ||
      !frame.epkSig ||
      !verifyEpk(
        session.clientKey,
        frame.s,
        frame.epk,
        frame.epkSig,
        resumeProofBinding(frame.agent, frame.token),
      )
    ) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'not_resumable' });
      return;
    }
    // A proven resumer resets failed guesses even when it loses the ordinary
    // refresh race. Otherwise five transient already_attached retries would
    // permanently lock out the real attachment.
    session.resumeAttempts = 0;
    // Attached means a live client the relay has not reported dead: a valid
    // token must not hijack a session out from under it. The refresh race
    // resolves through the wallet's retry — the detach lands within a second.
    if (session.detachedAt === undefined) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'already_attached' });
      return;
    }
    const now = this.#now();
    if (session.grant.expiresAt <= now) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
      return;
    }
    // Revocation closes and forgets a session, so the lookup above normally
    // fails first. This closes the race the review names: a resume already in
    // flight when the tombstone lands must not slip through the window
    // between recording it and finishing teardown (ADR-022 R4). It is kept in
    // addition to the stable-identity check above: the same attachment
    // identity may still hold an authorization the user has since revoked.
    if (session.delegation) {
      // A delegation authorizes the WHOLE logical attachment, not merely its
      // first open. A longer-lived grant must not carry a resumed session
      // past the root-signed authorization that created it.
      if (session.delegation.expiresAt <= now) {
        this.#send({ t: 'session.denied', s: frame.s, reason: 'authorization_expired' });
        return;
      }
      if (isRevoked(this.#revocations.list(), session.delegation)) {
        this.#send({ t: 'session.denied', s: frame.s, reason: 'revoked' });
        return;
      }
    }
    const mine = generateSealKeyPair();
    session.sealChannel = deriveSealChannel(mine.secretKey, frame.epk, frame.s, 'agent');
    session.detachedAt = undefined;
    const missed = session.missed;
    session.missed = 0;

    // ONE name, used for both the field and the proof. They used to be
    // computed separately — the field said 'Personal agent' for a delegated
    // session while the proof signed the real one — so verifyEpk failed at
    // the client and every delegated resume aborted with "agent sealing-key
    // proof failed". The open path already derived it once and got this
    // right; the resume path derived it twice and got it wrong, which is the
    // whole argument for deriving it once.
    const resumedAgentName = session.delegation ? 'Personal agent' : this.#options.identity.name;

    this.#send({
      t: 'session.resumed',
      s: frame.s,
      agentName: resumedAgentName,
      runtime: this.#options.identity.runtime,
      surface: session.surface,
      grant: session.grant,
      missed,
      // The attachment's policy is restated, not re-derived: a re-attachment
      // is the same attachment, and the page must be told again because it
      // deliberately kept nothing across the reload.
      ownTools: session.policy.mayUseOwnTools,
      epk: mine.publicKey,
      epkSig: signEpk(
        this.#options.identity.secretKey,
        frame.s,
        mine.publicKey,
        answerProofBinding('resume', session.clientKey, frame.epk, session.surface, session.grant, {
          agentName: resumedAgentName,
          runtime: this.#options.identity.runtime,
          missed,
          ownTools: session.policy.mayUseOwnTools,
        }),
      ),
    });
    this.#log.info('session resumed', { sessionId: frame.s, data: { missedFrames: missed } });
  }

  async #onSessionOpen(frame: Extract<Frame, { t: 'session.open' }>): Promise<void> {
    // Local policy lives here. A real daemon would consult a per-origin
    // allowlist; v0 accepts any session the relay authorised, but still
    // refuses grants it cannot honour.
    const now = this.#now();
    if (frame.grant.expiresAt <= now) {
      this.#send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
      return;
    }

    // Invariant 5 at the edge: with a stateless relay, the daemon re-checks
    // the complete proof presented by the opener. A delegation must be signed
    // by this agent's owner, name this agent and the relay-stamped client key,
    // match the forwarded surface origin, commit to exactly the grant this
    // frame presents, and still be live. A lying relay therefore cannot turn
    // a bad delegation into access, and a page holding the delegate key
    // cannot swap in a grant the user never approved.
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
        delegation.grantHash !== hashGrant(frame.grant) ||
        !delegationLifetimeOk(delegation) ||
        delegation.expiresAt <= now
      ) {
        this.#send({ t: 'session.denied', s: frame.s, reason: 'bad_delegation' });
        return;
      }
      // The user cut this origin off. The signature is still good and the
      // page still holds it — which is exactly the case revocation exists
      // for (ADR-022 R2).
      if (isRevoked(this.#revocations.list(), delegation)) {
        this.#send({ t: 'session.denied', s: frame.s, reason: 'revoked' });
        return;
      }
    } else if (!frame.viaConnect && frame.client !== cert?.user) {
      // Fail closed on ABSENT ownership as well as wrong ownership (ADR-019
      // Gate B §5, ADR-022 R5). This used to read `cert && frame.client !==
      // cert.user`, so an unbound daemon accepted whoever the relay stamped
      // and the property survived only because the relay refused too. It also
      // made unpair() an opening rather than a closing.
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

    // Reuse the keypair minted at consent time so the fingerprint the user
    // just compared is the fingerprint the session actually uses.
    let mine: KeyPair;
    if (frame.viaConnect) {
      const approved = this.#offerSeals.get(frame.epk);
      if (!approved || approved.at < this.#now() - CONNECT_APPROVAL_TTL_MS) {
        this.#offerSeals.delete(frame.epk);
        this.#send({ t: 'session.denied', s: frame.s, reason: 'connect_not_approved' });
        return;
      }
      mine = approved.keys;
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
    const viaConnect = Boolean(frame.viaConnect);
    const delegation = frame.delegation;
    // Decided before the answer is signed, because the answer states it: the
    // page is told what this attachment may do, and the statement is bound
    // into the epk proof so the relay cannot rewrite it (ADR-024 R11).
    const policy = attachmentPolicy(this.#trustedSurfaces({ delegation, viaConnect }));
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
          ownTools: policy.mayUseOwnTools,
        }),
      ),
    };

    const runtime = this.#options.createRuntime();
    const session: SessionState = {
      id: frame.s,
      viaConnect,
      policy,
      ...(delegation ? { delegation } : {}),
      surface: frame.surface,
      grant: frame.grant,
      tools: frame.grant.tools,
      runtime,
      transcript: [],
      toolCalls: new Map(),
      approvals: new Map(),
      asks: new Map(),
      prompts: new Map(),
      sealChannel,
      resumeToken,
      clientKey: frame.client,
      missed: 0,
      resumeAttempts: 0,
    };
    this.#sessions.set(frame.s, session);

    try {
      await runtime.openSession?.({
        surface: session.surface,
        grant: session.grant,
        tools: session.tools,
        policy: session.policy,
      });
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
      ownTools: session.policy.mayUseOwnTools,
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

    const authorityError = this.#authorityError(session);
    if (authorityError) {
      this.#log.warn('refused a prompt after attachment authority expired', {
        sessionId: session.id,
        data: { promptId: frame.id },
      });
      this.#sendSession(session, {
        t: 'done',
        s: session.id,
        promptId: frame.id,
        stopReason: 'error',
        error: authorityError.message,
      });
      return;
    }

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
      ask: (question, signal) => this.#ask(session, question, signal),
      say: (text) => {
        record('agent', text);
        this.#streamText(session, 'delta', frame.id, text);
      },
      think: (text) => {
        record('thought', text);
        this.#streamText(session, 'thought', frame.id, text);
      },
      plan: (steps) => {
        // Not recorded in the transcript: a plan is the *current* intention,
        // replaced whenever it changes, and a replay of every revision would
        // read as repetition rather than as the conversation. The runtime's
        // own store keeps whatever it keeps.
        this.#sendSession(session, {
          t: 'plan',
          s: session.id,
          promptId: frame.id,
          steps: steps.slice(0, MAX_PLAN_STEPS),
        });
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
        error: this.#bounded(toErr(err).message, MAX_ERROR_CHARS, 'done.error', session.id),
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
    const authorityError = this.#authorityError(session);
    if (authorityError) throw authorityError;
    const tool = session.tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool "${name}" is not in this session's grant`);

    // Only the code-carrying fallback lacks browser consent and moves this
    // gate to the daemon. A delegated session was authorised for this exact
    // surface in the wallet-origin popup; subsequent approvals therefore go
    // to its CLIENT panel, which is the consent boundary that replaces the
    // viaConnect terminal gate.
    if (session.viaConnect && (tool.requiresApproval || session.grant.alwaysAsk.includes(name))) {
      this.#log.info('surface tool awaiting terminal approval', { sessionId: session.id, data: { tool: name } });
      // A GRANTED tool, asked about in the terminal. The other caller of
      // onLocalApproval is the runtime's own capability, and until now the
      // two were indistinguishable to whoever was reading (ADR-023).
      const approved = await (this.#options.onLocalApproval?.('site_tool', `Run ${name}`, {
        name,
        arguments: args,
      }) ?? Promise.resolve(false));
      this.#log.info('terminal approval resolved', {
        sessionId: session.id,
        data: { tool: name, granted: approved },
      });
      if (!approved) throw new Error('declined by owner');
    }

    // The local consent surface may have taken the attachment across its
    // deadline. Never dispatch a call on authority that ended while the user
    // was deciding.
    const afterApproval = this.#authorityError(session);
    if (afterApproval) throw afterApproval;

    const id = randomId('call_');
    const deferred = new Deferred<unknown>();
    session.toolCalls.set(id, deferred);
    this.#log.info('surface tool call dispatched', {
      sessionId: session.id,
      data: {
        tool: name,
        toolCallId: id,
        browserApprovalRequired: !session.viaConnect &&
          (tool.requiresApproval === true || session.grant.alwaysAsk.includes(name)),
      },
    });
    const abort = () => {
      if (!session.toolCalls.delete(id)) return;
      this.#log.warn('surface tool call cancelled', {
        sessionId: session.id,
        data: { tool: name, toolCallId: id },
      });
      deferred.reject(signal?.reason instanceof Error ? signal.reason : new Error('tool call cancelled'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!signal?.aborted) this.#sendSession(session, { t: 'tool.call', s: session.id, id, name, arguments: args });
    return deferred.promise.finally(() => signal?.removeEventListener('abort', abort));
  }

  /**
   * Which of this attachment's consent surfaces can the requesting origin
   * neither draw, read, nor forge? (ADR-024 R1.)
   *
   * TWO answers, because there are two channels and they do not land on the
   * same surfaces. `decisions` is yes-or-no about one call; `questions`
   * carries fields. See `attachmentPolicy` for why this stopped being one
   * boolean.
   *
   * The first discriminator is DELEGATION, and the wire already separates the
   * tiers:
   *
   * - **Delegated** — the hosted wallet signed a short-lived authority for a
   *   page's ephemeral key, and that page answers in its own panel, which is
   *   DOM the requesting origin renders. FALSE for both, and no repair exists
   *   at the wallet origin: opening its popup needs user activation, and an
   *   agent-initiated question has no gesture behind it — which is exactly
   *   why `connect.ts` reserves its popup synchronously during the click. A
   *   persistent cross-origin frame would be readable-proof and not
   *   overlay-proof, which is the attack a real browser window exists to
   *   defeat.
   * - **Direct key** — no delegation: the client IS the owner's key, checked
   *   against the cert. TRUE for both.
   * - `viaConnect` — no delegation, and no browser wallet at all. Decisions
   *   are TRUE because `#requestApproval` actually routes them to the
   *   terminal. Questions are true only when the embedder supplied
   *   `onLocalAsk`, because that is the only thing that can render one.
   *
   * The direct-key row is the non-obvious one, so state the argument rather
   * than the conclusion. It covers the extension, whose consent window a page
   * can neither draw nor read — the easy case. It also covers today's in-page
   * demo wallet, and refusing THAT would protect nothing: a page holding the
   * user key can already mint any authority it likes, including a fresh
   * delegation to itself. This is the same self-referential argument that
   * makes page-answered `site_tool` approvals fine — the forger already holds
   * the capability, so there is no escalation left to prevent. Note the scope
   * of what this grants: the daemon is saying the CLIENT may be told, not
   * that the client may hand it to the page. A client holding the user key
   * that forwards the user's voice to page JavaScript has escalated on its
   * own behalf, and that is its bug to fix, not something the daemon can see.
   *
   * The `viaConnect` row is where this predicate was wrong, and it is worth
   * recording how. It read TRUE unconditionally, justified in a comment by
   * "answers at the daemon's own terminal, a surface no page can reach" —
   * except `#ask` never forked to the terminal the way `#requestApproval`
   * does. The frame went to the session client, and on this tier the client
   * is a page key the daemon deliberately does NOT check against a cert
   * (`connect.ts` mints it "ephemeral and authority-free"). So the one tier
   * whose client has no authority at all was the tier being handed the user's
   * voice, while the delegated tier — whose client at least holds a
   * user-signed delegation — was refused. The comment described the design;
   * only the routing was missing; and because the policy was a single
   * boolean, no type could express the disagreement.
   *
   * So the refusal lands where the escalation is: a client that does NOT hold
   * the user key, answering for the user.
   *
   * Takes only what it reads, so it can be answered before the session state
   * it will be stored on exists — the answer has to be signed into the reply
   * that opens the attachment.
   */
  #trustedSurfaces(session: Pick<SessionState, 'delegation' | 'viaConnect'>): {
    decisions: boolean;
    questions: boolean;
  } {
    // Both fields ask the same shape of question — is there a surface, and can
    // this daemon actually reach it — so both check the handler that reaches
    // it. `questions` guarded on `onLocalAsk` from the start and `decisions`
    // did not, which was an asymmetry with a user-visible cost: an embedder
    // with no `onLocalApproval` was told `mayUseOwnTools: true`, the page was
    // told `ownTools: true`, and then every request was refused by a bare
    // `return false` that logged nothing. The runtime believes it may, the
    // user is told it may, and it silently may not — the invisible
    // diminishment ADR-024 R4 exists to prevent, produced by the field meant
    // to prevent it.
    const owned = session.delegation === undefined;
    return {
      decisions: owned && (!session.viaConnect || this.#options.onLocalApproval !== undefined),
      questions: owned && (!session.viaConnect || this.#options.onLocalAsk !== undefined),
    };
  }


  /**
   * One question, one answer, and never a hang.
   *
   * Resolves `undefined` for every non-answer — skipped, aborted, timed out,
   * session gone. That is the ACP semantic too: declining means the tool runs
   * with no answers and the model is told the user skipped, while cancelling
   * aborts the turn. An unanswered question must decay into the first, not
   * the second: losing the user's work because nobody clicked is a worse
   * failure than proceeding without an answer.
   */
  #ask(
    session: SessionState,
    question: AskQuestion,
    signal?: AbortSignal,
  ): Promise<AskAnswers | undefined> {
    // The capability declaration is what SHOULD stop this — a runtime that
    // sees mayAsk false never advertises the tool, so its agent has no way to
    // ask (ADR-024 R2). But that is the runtime honouring a policy, and this
    // is the daemon: a runtime that ignored it, or one we did not write,
    // would otherwise put a question on a tier where the PAGE answers it, and
    // the answer would arrive carrying the user's authority while being
    // authored by the site. R2's own falsifiability clause said this needed
    // closing if negotiation ever stopped being sufficient; it costs one
    // check, so it does not wait for that to be demonstrated.
    //
    // Resolving undefined rather than throwing keeps the contract: every
    // non-answer means "proceed without one", and a runtime asking where it
    // may not is a bug to log, not a turn to destroy.
    if (!session.policy.mayAsk) {
      this.#log.warn('runtime asked on an attachment with no trusted answer surface; declining', {
        sessionId: session.id,
      });
      return Promise.resolve(undefined);
    }

    // Past the guard there are two trusted surfaces, exactly as
    // `#requestApproval` has them: the connect tier has no wallet, so its
    // questions stay with the daemon owner at the terminal, and everything
    // else is a DIRECT-KEY attachment whose client is the owner's own key.
    // This fork is the one that did not exist — the frame used to go to the
    // client on every tier, including the one whose client is an
    // authority-free page key.
    if (session.viaConnect) {
      const onLocalAsk = this.#options.onLocalAsk;
      // `#trustedSurfaces` cannot set mayAsk on this tier without it, so this
      // is a second lock on the same door rather than a reachable branch.
      if (!onLocalAsk) return Promise.resolve(undefined);
      // "Never a hang" has to hold for an embedder's terminal too, so the
      // local path carries the same deadline and abort as the wire path.
      return new Promise<AskAnswers | undefined>((resolve) => {
        let settled = false;
        const finish = (answers: AskAnswers | undefined): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(answers);
        };
        const onAbort = (): void => finish(undefined);
        const timer = setTimeout(() => {
          this.#log.info('nobody answered the agent at the terminal; proceeding as skipped', {
            sessionId: session.id,
          });
          finish(undefined);
        }, ASK_TIMEOUT_MS);
        if (signal?.aborted) return finish(undefined);
        signal?.addEventListener('abort', onAbort, { once: true });
        onLocalAsk(question).then(finish, (err: unknown) => {
          this.#log.error('the local ask surface failed; proceeding as skipped', {
            sessionId: session.id,
            err,
          });
          finish(undefined);
        });
      });
    }

    const id = randomId('ask_');
    const deferred = new Deferred<AskAnswers | undefined>();
    session.asks.set(id, deferred);

    // Registered before the frame leaves, so an instant answer cannot arrive
    // before there is anything to resolve. Delete's own boolean is the
    // single-winner interlock, so a timeout racing an answer cannot resolve
    // twice — the same ordering the approval path depends on.
    const settle = (): boolean => session.asks.delete(id);
    const abort = () => {
      if (settle()) deferred.resolve(undefined);
    };
    const timer = setTimeout(() => {
      if (settle()) {
        this.#log.info('nobody answered the agent; proceeding as skipped', { sessionId: session.id });
        deferred.resolve(undefined);
      }
    }, ASK_TIMEOUT_MS);

    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!signal?.aborted) {
      this.#sendSession(session, {
        t: 'ask',
        s: session.id,
        id,
        message: this.#bounded(question.message, MAX_DESCRIPTION_CHARS, 'ask.message', session.id),
        fields: question.fields,
      });
    }
    return deferred.promise.finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  }

  #requestApproval(
    session: SessionState,
    summary: string,
    call?: { name: string; arguments: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<boolean> {
    // Everything reaching this method is the agent's OWN capability — the
    // domain stamped below is a constant for that reason — so this fork is
    // where ADR-024 R11 lands: a page may answer for its own capability, never
    // for the user's, and never as the user.
    //
    // REFUSAL, not a reroute. The delegated tier has no surface that could
    // answer this: a wallet-origin popup needs a user gesture the agent does
    // not have mid-turn, and a cross-origin frame the page can cover is not a
    // consent surface. So there is nobody who may say yes, and asking anyway
    // would mean asking the party we are protecting the user from.
    //
    // `!== true`, not falsiness, and fail-closed: an attachment that does not
    // positively carry this authority does not have it. Refusing here costs
    // one synchronous return and cannot hang — the caller gets the same `false`
    // a human decline produces, which every runtime already handles.
    if (session.policy.mayUseOwnTools !== true) {
      this.#log.warn('refused an own-tool approval: this attachment has no surface that may answer for the user', {
        sessionId: session.id,
        data: { origin: session.surface.origin, delegated: session.delegation !== undefined },
      });
      return Promise.resolve(false);
    }

    // Past the guard there are two trusted surfaces, and which one depends on
    // whether a browser wallet was ever involved. The code-carrying fallback
    // has none, so its questions stay with the daemon owner at the terminal.
    // Everything else here is a DIRECT-KEY attachment — the client is the
    // owner's own key — so the question goes to that wallet, which is the
    // extension's consent window when the extension is the wallet.
    if (session.viaConnect) {
      const ask = this.#options.onLocalApproval;
      if (!ask) {
        // `#trustedSurfaces` cannot set `decisions` on this tier without it, so
        // this is a second lock rather than a reachable branch — but it used to
        // be the FIRST lock and it denied in silence, which is how an embedder
        // could be refused every own-tool call without anything saying why.
        this.#log.warn('no local approval surface on this tier; refusing the agent its own tool', {
          sessionId: session.id,
        });
        return Promise.resolve(false);
      }
      return ask('runtime_own_tool', summary, call);
    }

    const id = randomId('appr_');
    const deferred = new Deferred<boolean>();
    const callHash = call ? hashCall(call) : undefined;
    session.approvals.set(id, { decision: deferred, ...(callHash ? { callHash } : {}) });
    const abort = () => {
      if (!session.approvals.delete(id)) return;
      deferred.resolve(false);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!signal?.aborted) {
      // The domain is a CONSTANT here, not a parameter, and that is the
      // enforcement (ADR-023 R2). `TurnContext.requestApproval` is the only
      // way a runtime can reach this, so everything arriving through it is by
      // construction the runtime's own capability — and the runtime is
      // precisely the party that must not get to say otherwise, since the
      // `summary` beside it is already agent-authored text that page content
      // steers. A parameter would be a self-declared field.
      this.#sendSession(session, {
        t: 'approval.request',
        s: session.id,
        id,
        domain: 'runtime_own_tool',
        summary,
        ...(call ? { call } : {}),
        ...(callHash ? { callHash } : {}),
      });
    }
    return deferred.promise.finally(() => signal?.removeEventListener('abort', abort));
  }

  /**
   * Truncates an operational string (error detail, close reason) to its wire
   * bound. Only lengths are logged: runtime error messages can embed tool
   * output, which is hostile data, not log material.
   */
  #bounded(value: string, max: number, field: string, sessionId?: string): string {
    if (value.length <= max) return value;
    this.#log.warn('outbound string truncated to wire bound', {
      ...(sessionId ? { sessionId } : {}),
      data: { field, max, length: value.length },
    });
    return `${value.slice(0, max - 1)}…`;
  }

  /**
   * Conversation content is never truncated silently: a runtime chunk larger
   * than the wire's text bound is split across frames instead. Empty text
   * still emits one frame, matching the pre-bounding behavior.
   */
  #streamText(session: SessionState, t: 'delta' | 'thought', promptId: string, text: string): void {
    if (text.length > MAX_TEXT_CHARS) {
      this.#log.info('splitting oversized runtime text across frames', {
        sessionId: session.id,
        data: { type: t, length: text.length, frames: Math.ceil(text.length / MAX_TEXT_CHARS) },
      });
    }
    let offset = 0;
    do {
      let end = Math.min(offset + MAX_TEXT_CHARS, text.length);
      // Never cut between a surrogate pair: the halves are not well-formed
      // Unicode, and the wire schema rejects them. Back off one unit when the
      // boundary lands inside a pair (a chunk of exactly one high surrogate
      // cannot happen, since MAX_TEXT_CHARS is far larger than 1).
      const code = text.charCodeAt(end - 1);
      if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
      this.#sendSession(session, { t, s: session.id, promptId, text: text.slice(offset, end) });
      offset = end;
    } while (offset < text.length);
  }

  /**
   * History is a replay, not the source of truth — the runtime's own store
   * keeps the full text — so the wire copy is bounded: newest entries kept up
   * to the schema's entry cap and a conservative sealed-plaintext budget,
   * oversized lines truncated. Timestamps outside the protocol domain become
   * 0 — the schema's explicit "unknown" (ACP replay has no timestamps) — and
   * are never fabricated from our own clock.
   */
  #boundedHistory(sessionId: string, source: HistoryEntry[]): { entries: HistoryEntry[]; truncated: boolean } {
    let truncated = 0;
    let unstamped = 0;
    const bounded = source.map((entry): HistoryEntry => {
      const cut = entry.text.length > MAX_TEXT_CHARS;
      if (cut) truncated++;
      const inDomain = entry.at >= TIMESTAMP_MIN && entry.at <= TIMESTAMP_MAX;
      if (!inDomain && entry.at !== 0) unstamped++;
      return {
        role: entry.role,
        text: cut ? `${entry.text.slice(0, MAX_TEXT_CHARS - 1)}…` : entry.text,
        at: inDomain ? entry.at : 0,
      };
    });
    let used = 0;
    let keep = 0;
    for (let i = bounded.length - 1; i >= 0 && keep < MAX_HISTORY_ENTRIES; i--) {
      used += JSON.stringify(bounded[i]!).length + 1;
      if (used > HISTORY_BUDGET_CHARS) break;
      keep++;
    }
    const dropped = bounded.length - keep;
    if (truncated > 0 || unstamped > 0 || dropped > 0) {
      this.#log.warn('history replay bounded for the wire', {
        sessionId,
        data: { entries: bounded.length, dropped, truncatedTexts: truncated, unknownTimestamps: unstamped },
      });
    }
    return { entries: bounded.slice(bounded.length - keep), truncated: truncated > 0 || dropped > 0 };
  }

  #cancelInFlight(session: SessionState, reason: string): void {
    for (const controller of session.prompts.values()) controller.abort();
    for (const pending of session.toolCalls.values()) pending.reject(new Error(reason));
    session.toolCalls.clear();
    for (const pending of session.approvals.values()) pending.decision.resolve(false);
    // Undefined, not a rejection: a torn-down session means "proceed without
    // an answer", which is the same thing an unanswered question means.
    for (const pending of session.asks.values()) pending.resolve(undefined);
    session.approvals.clear();
  }

  async #closeSession(session: SessionState, reason: string, notify = true): Promise<void> {
    // Claim teardown synchronously. A client close and daemon shutdown can
    // arrive in the same tick; only the caller that still owns the map entry
    // may close the runtime or emit the terminal frame.
    if (this.#sessions.get(session.id) !== session) return;
    this.#sessions.delete(session.id);
    this.#cancelInFlight(session, 'session closed');
    try {
      await session.runtime.closeSession?.();
    } catch (err) {
      this.#log.error('runtime failed to close session', { sessionId: session.id, err, data: { reason } });
    } finally {
      if (notify) {
        this.#send({
          t: 'session.close',
          s: session.id,
          reason: this.#bounded(reason, MAX_REASON_CHARS, 'session.close.reason', session.id),
        });
      }
      this.#log.info('session closed', { sessionId: session.id, data: { reason } });
    }
  }
}

/** One live attachment, projected for `agentport status` and the wallet. */
export interface Attachment {
  id: string;
  origin: string;
  surface: string;
  tools: number;
  grantExpiresAt: number;
  delegated: boolean;
  /** Unix ms since the client's socket went away, or undefined if attached. */
  detachedAt?: number;
}
