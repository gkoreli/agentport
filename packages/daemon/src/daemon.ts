/**
 * The session aggregate: one attachment's whole life, in one file.
 *
 * Its size is deliberate and the split that produced it was too. Two passengers
 * moved out — `relay-link.ts` (the socket: dial, ping, backoff, redial) and
 * `bounds.ts` (the pure wire arithmetic) — because neither shared any state
 * with a session. What is left is ONE thing: open, resume, prompt, tool,
 * approval, ask, close, over `SessionState`.
 *
 * **Do not scatter it because it is long.** Invariant 2 is enforced at four
 * points that only look alike if you can see them together — prompt admission,
 * tool dispatch, dispatch again after a human took minutes to decide, and a
 * tool result arriving late — and every one of them was, at some point, the one
 * that was missing a clause. `AttachmentAuthority` (`authority.ts`) is the rule
 * they all ask; this file is the set of places that must remember to ask it. A
 * size-driven refactor that put "resume" in one module and "tool dispatch" in
 * another would hide exactly the symmetry that makes a missing checkpoint
 * visible on one screen.
 */

import {
  Deferred,
  Emitter,
  MAX_DESCRIPTION_CHARS,
  MAX_ERROR_CHARS,
  MAX_MISSED_COUNT,
  MAX_PLAN_STEPS,
  MAX_REASON_CHARS,
  MAX_SESSIONS_REPORTED,
  MAX_TEXT_CHARS,
  SEALED_TYPES,
  SESSION_DENIAL_REASONS,
  NonceMismatchError,
  WireViolation,
  answerProofBinding,
  authChallengeMessage,
  createLogger,
  deriveSealChannel,
  delegationAuthorizes,
  fingerprintWords,
  generateSealKeyPair,
  hashCall,
  isGated,
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
import { AttachmentAuthority, type AuthorityDenied } from './authority.js';
import { boundHistory, boundString, textChunks } from './bounds.js';
import { RelayLink } from './relay-link.js';
import { memoryRevocations, type Revocation, type RevocationStore } from './revocations.js';
import {
  attachmentPolicy,
  type AskAnswers,
  type AskQuestion,
  type AgentRuntime,
  type AttachmentPolicy,
  type TurnContext,
} from './runtime.js';

/** One gated call, as both consent channels describe it. */
type ApprovalCall = { name: string; arguments: Record<string, unknown> };

/**
 * Where this attachment's two consent channels actually LAND.
 *
 * Resolved once, when the session opens, and stored on it. Both fields are
 * `undefined` exactly when no surface may answer, which is what
 * `attachmentPolicy` is then derived from — so the policy the page is told and
 * the destination a request reaches are one fact rather than two evaluations
 * that have to keep agreeing (ADR-024 R12).
 *
 * That is the whole reason this type exists. `#ask` and `#requestApproval`
 * each re-derived the `viaConnect` fork for themselves, under a comment in
 * each calling the other one a "second lock on the same door" — and they had
 * already drifted apart: one armed a deadline on both of its paths and the
 * other armed none at all, so a wallet that accepted an `approval.request` and
 * never answered blocked the agent's turn until a human cancelled it. A fork
 * written twice is a fork that will be written differently twice.
 *
 * Each destination takes its own session back as its first argument rather
 * than closing over it: the policy has to be signed into `session.opened`,
 * which happens BEFORE the `SessionState` exists.
 */
interface ConsentRouting {
  /**
   * Ask the user to allow the agent its OWN capability, or `undefined` when no
   * surface here may answer for them (ADR-024 R11 — refusal, not a reroute).
   */
  decide?: (session: SessionState, summary: string, call?: ApprovalCall, signal?: AbortSignal) => Promise<boolean>;
  /**
   * Put the agent's question to the user, or `undefined` when nobody here may
   * answer in the user's name.
   */
  ask?: (session: SessionState, question: AskQuestion, signal?: AbortSignal) => Promise<AskAnswers | undefined>;
}

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
  /**
   * Unix ms at which this attachment's own authority began.
   *
   * Retained for the same reason `delegation` is, and for the tier that has
   * none: it is the instant a per-origin tombstone judges a DIRECT-KEY session
   * against (ADR-022 addendum). A resume must not restart it, which is exactly
   * what makes a revoked extension attachment unresumable rather than merely
   * closed.
   */
  readonly openedAt: number;
  /**
   * "May this attachment do X, right now?", as one object rather than three
   * spellings. Built once at open and NOT rebuilt on resume: a resume is the
   * same attachment returning, so its grant, its delegation and the instant
   * its authority began are all unchanged.
   */
  readonly authority: AttachmentAuthority;
  /** Where this attachment's consent actually lands (ADR-024 R12). */
  readonly routing: ConsentRouting;
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
 * How long the agent waits for a DECISION before proceeding as declined.
 *
 * Its own constant beside `ASK_TIMEOUT_MS` rather than a shared one, because
 * the two channels decay in opposite directions and only one of them is safe
 * by default: an unanswered question means "proceed without an answer", while
 * an unanswered decision must mean NO. A deadline that granted would be a
 * standing yes nobody said, so every expiry on this channel resolves false.
 *
 * The same five minutes, for the same reason — a human has to read a summary
 * and decide — and finite for a sharper one. This channel had no deadline at
 * all: the terminal fork awaited a handler that might never settle, and the
 * wire fork armed nothing, so a browser wallet that accepted an
 * `approval.request` and never answered blocked the agent's turn until a human
 * cancelled it. Tenet: a hang is indistinguishable from slowness.
 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How often the daemon sweeps its own state: stale connect offers, detached
 * sessions past the grace, and revocation tombstones.
 *
 * The tombstone sweep lives HERE rather than only in `cli.ts` because a public
 * `enforceRevocations()` that nothing calls on a schedule makes revocation
 * look handled while every embedder but one honours tombstones at open and
 * never again (ADR-022 addendum). The CLI still nudges it far more often, so
 * the shipped path is unchanged; this is the floor underneath every other
 * embedder.
 *
 * It is also the `RelayLink` tick cadence, which the link's own ping divides
 * down to `PING_INTERVAL_MS`. That is why the sweep runs only while a socket
 * exists: it always did, and moving the timer without moving that property
 * would have quietly started sweeping through backoff.
 */
const SWEEP_INTERVAL_MS = 30_000;

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
  /**
   * Test seam for the housekeeping cadence — stale connect offers, detached
   * sessions, revocation tombstones. The default is thirty seconds, and a
   * check that waited one out is a check nobody runs, so the only way to
   * OBSERVE a live sweep at all is to shorten it. The liveness ping keeps its
   * own cadence on top of this and is unaffected.
   */
  sweepIntervalMs?: number;
  /**
   * Test seam for the approval deadline. Same argument as the sweep: the
   * product deadline is five minutes, and "an unanswered approval declines"
   * cannot be observed by a suite that has to wait for one.
   */
  approvalTimeoutMs?: number;
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
  /**
   * The socket, at arm's length (`relay-link.ts`). It hands up decoded frames
   * and a beat; it is told when the handshake landed, because that is a
   * protocol judgement and the link makes none.
   */
  #link: RelayLink;
  #sessions = new Map<string, SessionState>();
  /**
   * Sealing keypairs minted at connect-offer time, keyed by the client epk,
   * with the moment they were approved.
   *
   * An approval the widget never redeemed used to sit here for the process's
   * lifetime: consent said yes, the session never opened, and the keypair
   * stayed redeemable. That is a standing "yes" for a decision the user made
   * once, minutes or days ago — and unlike a delegation it carries no origin,
   * so revoking an origin structurally cannot reach it (ADR-022). The sweep
   * expires it on the same schedule the relay expires the connect code itself.
   */
  #offerSeals = new Map<string, { keys: KeyPair; at: number }>();
  #log: Logger;
  #readyDeferred = new Deferred<{ bound: boolean }>();
  #authenticated = false;
  #revocations: RevocationStore;

  constructor(options: DaemonOptions) {
    super();
    this.#options = options;
    this.#log = createLogger('daemon', { sink: options.sink });
    this.#revocations = options.revocations ?? memoryRevocations();
    this.#link = new RelayLink({
      url: options.relayUrl,
      log: this.#log,
      handshakeTimeoutMs: options.handshakeTimeoutMs,
      // The housekeeping cadence is ours; the link's ping divides it down to
      // its own so a 200 ms test sweep cannot become a 200 ms pong deadline.
      tickIntervalMs: options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
    });
    this.#link.on('frame', (frame) => {
      void this.#onFrame(frame).catch((err: unknown) => {
        this.#log.error('failed to handle relay frame', {
          err,
          ...('s' in frame ? { sessionId: frame.s } : {}),
          data: { frameType: frame.t, relayUrl: options.relayUrl },
        });
      });
    });
    this.#link.on('tick', () => this.#sweep());
    this.#link.on('down', () => this.#onLinkDown());
    // A socket that cannot come up is only the caller's business until the
    // handshake lands; the Deferred is settle-once, so a later arrival — a
    // redial that refuses, say — stays what it already was, a logged failure.
    this.#link.on('failed', (err) => this.#readyDeferred.reject(err));
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  /**
   * The attachment boundary, asked at this daemon's clock.
   *
   * A thin call through `AttachmentAuthority`, which owns the rule: the
   * intersection of grant and delegation, plus the tombstones the user may
   * have written since. Consulted on LIVE traffic, not just open and resume —
   * staying connected must not turn a short delegation into a longer grant,
   * and a tool result arriving after the boundary must not complete work whose
   * authority ended while it was in flight.
   */
  #authorityError(session: Pick<SessionState, 'authority'>): AuthorityDenied | undefined {
    return session.authority.error(this.#now());
  }

  get identity(): AgentIdentity {
    return this.#options.identity;
  }

  /**
   * Connects, and STAYS connected: a relay redeploy (Durable Objects sever
   * every socket when the Worker updates), an idle eviction, or any network
   * blip is survived by redialing with backoff — all of which is the link's
   * job now. What is settled HERE is what `ready` means, because that is a
   * frame and the link reads none.
   */
  async start(): Promise<{ bound: boolean }> {
    this.#link.start();
    return this.#readyDeferred.promise;
  }

  /**
   * Housekeeping, on the link's beat: stale connect offers, detached sessions
   * past the grace, and revocation tombstones.
   *
   * It rides the socket's interval rather than one of its own — which is where
   * it has always run, and the reason is worth keeping: a sweep timer that
   * outlived the socket would start sweeping through backoff, which is a
   * different daemon from the one that shipped.
   */
  #sweep(): void {
    // An approval the widget never redeemed is a standing "yes" with no origin
    // behind it, so it expires on the relay's own connect-code schedule.
    const staleOffer = this.#now() - CONNECT_APPROVAL_TTL_MS;
    for (const [epk, offer] of this.#offerSeals) {
      if (offer.at < staleOffer) this.#offerSeals.delete(epk);
    }
    // Detached sessions do not wait forever: past the grace, close the
    // runtime and forget the token.
    const cutoff = this.#now() - DETACH_GRACE_MS;
    for (const session of [...this.#sessions.values()]) {
      if (session.detachedAt !== undefined && session.detachedAt < cutoff) {
        void this.#closeSession(session, 'client_never_returned', false).catch((err: unknown) => {
          this.#log.error('failed to expire detached session', { sessionId: session.id, err });
        });
      }
    }
    // The user may have written a tombstone while this session was live, and
    // `agentport revoke` never talks to this process — so a live attachment
    // is judged again HERE, not only when it next resumes (ADR-022 R11). The
    // CLI's control poll calls the same idempotent method far more often;
    // this is the floor for every other embedder, which previously had none.
    void this.enforceRevocations().catch((err: unknown) => {
      this.#log.error('could not close revoked attachments', { err });
    });
  }

  /**
   * The socket went away. The relay is stateless: losing it detaches every
   * session but kills none. Clients come back with their tokens through
   * whatever relay socket exists next, and this daemon is the one that
   * remembers them.
   */
  #onLinkDown(): void {
    this.#authenticated = false;
    const now = this.#now();
    for (const session of this.#sessions.values()) {
      if (session.detachedAt === undefined) session.detachedAt = now;
    }
    this.emit('closed', undefined);
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
   * Close every attachment a tombstone already covers, and refresh what the
   * survivors believe about the tombstones.
   *
   * `agentport revoke` writes the tombstone durably and does not talk to this
   * process — the store re-reads the file, so open and resume are refused
   * immediately. But a session that is already live is not judged again until
   * it resumes, and ADR-022 R11 requires it to end. The daemon's own sweep
   * calls this, and the CLI's control poll nudges it far more often; it is
   * idempotent, so a repeat costs nothing.
   *
   * ONE store read serves every live attachment, which is why the list is read
   * here and handed to each authority rather than looked up per session.
   */
  async enforceRevocations(): Promise<number> {
    const revocations = this.#revocations.list();
    const doomed = [...this.#sessions.values()].filter((session) => session.authority.observe(revocations));
    for (const session of doomed) await this.#closeSession(session, SESSION_DENIAL_REASONS.revoked);
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
    for (const session of doomed) await this.#closeSession(session, SESSION_DENIAL_REASONS.revoked);

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

    for (const session of [...this.#sessions.values()]) await this.#closeSession(session, SESSION_DENIAL_REASONS.revoked);

    this.#log.info('agent unpaired');
    this.emit('unbound', undefined);
    // Re-identify without the cert. The socket close triggers the ordinary
    // redial path, which presents whatever identity we now hold.
    this.#link.close();
  }

  async stop(): Promise<void> {
    // Stop redialing FIRST, so a close landing mid-teardown does not schedule a
    // fresh dial — and only then close the socket, because every session still
    // has a `session.close` to send over it.
    this.#link.stop();
    for (const session of this.#sessions.values()) await this.#closeSession(session, 'daemon_stopping');
    this.#link.close();
  }

  /**
   * The daemon's one outbound door. A pass-through to the link today, kept
   * because `#sendSession` is built on it: sealed-or-clear is decided in one
   * place, above the socket, and twenty call sites do not each have to know
   * which layer they are talking to.
   */
  #send(frame: Frame): void {
    this.#link.send(frame);
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
        this.#authenticated = true;
        // The link cannot know this: it forwards frames and reads none. Telling
        // it disarms the handshake deadline and forgets the backoff.
        this.#link.handshakeSucceeded();
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
        // `lateError`, not `error`: this frame ANSWERS a call whose authority
        // was already judged, with a fresh look at the tombstones, when it was
        // dispatched. See `AttachmentAuthority#lateError` for why a second
        // read on the receive path buys nothing.
        const authorityError = session.authority.lateError(this.#now());
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
          this.#link.fail(
            new Error(`the relay refused this daemon: ${frame.code}${frame.message ? ` — ${frame.message}` : ''}`),
          );
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
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.not_resumable });
      return;
    }
    if (++session.resumeAttempts > MAX_RESUME_ATTEMPTS) {
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.not_resumable });
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
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.not_resumable });
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
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.not_resumable });
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
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.already_attached });
      return;
    }
    // The SAME boundary the live traffic is judged against, re-judged before a
    // fresh channel replaces the detached one. Three clauses, one judge:
    //
    // - the grant's own deadline;
    // - the delegation's, because a delegation authorizes the WHOLE logical
    //   attachment and not merely its first open — a longer-lived grant must
    //   not carry a resumed session past the root-signed authorization that
    //   created it;
    // - the tombstones. Revocation closes and forgets a session, so the lookup
    //   above normally fails first; this closes the race the consent review
    //   names, where a resume is already in flight when the tombstone lands
    //   (ADR-022 R4). It is kept in addition to the stable-identity check
    //   above, because the same attachment identity may still hold an
    //   authority the user has since withdrawn.
    //
    // The tombstone clause used to sit inside `if (session.delegation)`, which
    // meant an extension attachment — direct key, no delegation — resumed
    // straight through a revocation (ADR-022 addendum). The authority judges
    // by ORIGIN now, so both tiers are refused here.
    const denial = this.#authorityError(session);
    if (denial) {
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS[denial.reason] });
      return;
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
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.grant_expired });
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
      // The same judge the relay runs, plus the two clauses only this end can
      // apply: it knows the owner key and it can compare the signed origin
      // against the surface the frame claims. An UNBOUND daemon has no owner
      // to have signed anything, so there is nothing to judge — refuse rather
      // than fall through to a shorter conjunction.
      const denial = cert
        ? delegationAuthorizes(delegation, {
            owner: cert.user,
            agent: this.#options.identity.publicKey,
            delegate: frame.client,
            origin: frame.surface.origin,
            grant: frame.grant,
            now,
          })
        : 'sig';
      if (denial) {
        // Logged as a closed-set word, sent as one: `bad_delegation` on the
        // wire covers all eight clauses, so a page learns that its authority
        // did not hold and nothing about which binding failed.
        this.#log.warn('refused a delegated session', { sessionId: frame.s, data: { denial } });
        this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.bad_delegation });
        return;
      }
    } else if (!frame.viaConnect && frame.client !== cert?.user) {
      // Fail closed on ABSENT ownership as well as wrong ownership (ADR-019
      // Gate B §5, ADR-022 R5). This used to read `cert && frame.client !==
      // cert.user`, so an unbound daemon accepted whoever the relay stamped
      // and the property survived only because the relay refused too. It also
      // made unpair() an opening rather than a closing.
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.not_your_agent });
      return;
    }

    // The attachment boundary, built once and then both enforced and re-judged
    // through this one object for the rest of the session's life.
    //
    // Judging it HERE also applies the tombstones, and it applies them to BOTH
    // tiers. For a delegated attachment that is ADR-022 R2 unchanged: the
    // signature is still good and the page still holds it, which is exactly
    // the case revocation exists for. For a direct-key attachment the
    // authority began just now, so a past tombstone cannot cover it — which is
    // the tombstone's own shape (approving again works with no un-revoke verb)
    // and safe here because a direct-key open is the user's own key answering
    // for itself. The clause is written once for both rather than nested
    // inside the delegated branch, which is where it used to hide.
    const authority = new AttachmentAuthority({
      grant: frame.grant,
      ...(frame.delegation ? { delegation: frame.delegation } : {}),
      origin: frame.surface.origin,
      openedAt: now,
      revocations: this.#revocations,
    });
    const authorityDenial = authority.error(now);
    if (authorityDenial) {
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS[authorityDenial.reason] });
      return;
    }

    // Sealing handshake. The epk proof is signed by the client identity the
    // relay stamped, over a scope that stops replay into another session
    // ('connect' pre-session for the drop-in flow, the session id otherwise).
    if (!frame.epk || !frame.epkSig || !frame.client) {
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.sealing_required });
      return;
    }
    const scope = frame.viaConnect ? 'connect' : frame.s;
    const requestBinding = frame.viaConnect
      ? openProofBinding('connect', frame.surface, frame.grant)
      : openProofBinding('open', frame.surface, frame.grant, frame.agent);
    if (!verifyEpk(frame.client, scope, frame.epk, frame.epkSig, requestBinding)) {
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.bad_epk_proof });
      return;
    }

    // Reuse the keypair minted at consent time so the fingerprint the user
    // just compared is the fingerprint the session actually uses.
    let mine: KeyPair;
    if (frame.viaConnect) {
      const approved = this.#offerSeals.get(frame.epk);
      if (!approved || approved.at < this.#now() - CONNECT_APPROVAL_TTL_MS) {
        this.#offerSeals.delete(frame.epk);
        this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.connect_not_approved });
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
    // Resolved before the answer is signed, because the answer STATES it: the
    // page is told what this attachment may do, and the statement is bound
    // into the epk proof so the relay cannot rewrite it (ADR-024 R11).
    //
    // The routing is built first and the policy read off it, never the other
    // way round. A policy asserted separately from the routing is a claim
    // about a destination, and a check that reads `policy.mayAsk` passes just
    // as happily on a daemon that hands the question to the requesting site
    // (ADR-024 R12).
    const routing = this.#consentRouting({ delegation, viaConnect });
    const policy = attachmentPolicy({
      decisions: routing.decide !== undefined,
      questions: routing.ask !== undefined,
    });
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
      openedAt: now,
      authority,
      routing,
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
      this.#send({ t: 'session.denied', s: frame.s, reason: SESSION_DENIAL_REASONS.runtime_failed });
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
    // Membership is part of the same boundary, not a separate lookup beside
    // it: "may this attachment do X right now" has one answer and one place
    // that gives it.
    const tool = session.authority.allows(name);
    if (!tool) throw new Error(`tool "${name}" is not in this session's grant`);

    // Only the code-carrying fallback lacks browser consent and moves this
    // gate to the daemon. A delegated session was authorised for this exact
    // surface in the wallet-origin popup; subsequent approvals therefore go
    // to its CLIENT panel, which is the consent boundary that replaces the
    // viaConnect terminal gate.
    if (session.viaConnect && isGated(tool, session.grant)) {
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
        browserApprovalRequired: !session.viaConnect && isGated(tool, session.grant),
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
   * Where can this attachment's consent actually be drawn — and therefore
   * where does each channel's request GO? (ADR-024 R1/R12.)
   *
   * TWO answers, because there are two channels and they do not land on the
   * same surfaces. A DECISION is yes-or-no about one call; a QUESTION carries
   * fields and free text. See `attachmentPolicy` for why this stopped being
   * one boolean.
   *
   * This returns the destinations themselves rather than a pair of booleans
   * about them, and that is the invariant, not a refactor. `attachmentPolicy`
   * is derived from which destinations EXIST, so building the surface is what
   * grants the capability — where it used to be *asserted* by a predicate
   * beside routing that two other methods each re-derived for themselves. A
   * policy whose justification names a destination must be produced by the
   * same code that routes there; a check that reads `policy.mayAsk` passes
   * just as happily on a daemon that hands the question to the requesting
   * site, which is exactly what used to happen.
   *
   * The first discriminator is DELEGATION, and the wire already separates the
   * tiers:
   *
   * - **Delegated** — the hosted wallet signed a short-lived authority for a
   *   page's ephemeral key, and that page answers in its own panel, which is
   *   DOM the requesting origin renders. NEITHER destination exists, and no
   *   repair exists at the wallet origin: opening its popup needs user
   *   activation, and an agent-initiated question has no gesture behind it —
   *   which is exactly why `connect.ts` reserves its popup synchronously
   *   during the click. A persistent cross-origin frame would be
   *   readable-proof and not overlay-proof, which is the attack a real browser
   *   window exists to defeat.
   * - **Direct key** — no delegation: the client IS the owner's key, checked
   *   against the cert. Both destinations are that client, over the sealed
   *   channel.
   * - `viaConnect` — no delegation, and no browser wallet at all. Both
   *   destinations are the daemon's own terminal, and each exists only when
   *   the embedder supplied the handler that renders it. An embedder with no
   *   terminal — a test, a service — therefore gets the refusing behaviour by
   *   default rather than silently forwarding either channel to the requesting
   *   page.
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
   * The `viaConnect` row is where the old predicate was wrong, and it is worth
   * recording how. `questions` read TRUE unconditionally, justified in a
   * comment by "answers at the daemon's own terminal, a surface no page can
   * reach" — except `#ask` never forked to the terminal the way
   * `#requestApproval` did. The frame went to the session client, and on this
   * tier the client is a page key the daemon deliberately does NOT check
   * against a cert (`connect.ts` mints it "ephemeral and authority-free"). So
   * the one tier whose client has no authority at all was the tier being
   * handed the user's voice, while the delegated tier — whose client at least
   * holds a user-signed delegation — was refused. The comment described the
   * design; only the routing was missing. Resolving the destination and
   * reading the policy off it is what makes that state unrepresentable rather
   * than merely fixed.
   *
   * `decisions` then repeated the mirror of it: it did not check
   * `onLocalApproval` at all, so an embedder with no approval surface was told
   * `mayUseOwnTools: true`, the page was told `ownTools: true`, and every
   * request was refused by a bare `return false` that logged nothing — the
   * invisible diminishment ADR-024 R4 exists to prevent, produced by the field
   * meant to prevent it.
   *
   * Takes only what it reads, so it can be answered before the session state
   * it will be stored on exists — the answer has to be signed into the reply
   * that opens the attachment.
   */
  #consentRouting(tier: Pick<SessionState, 'delegation' | 'viaConnect'>): ConsentRouting {
    // Delegated: refusal, never a reroute. There is no surface in this tier
    // the requesting origin cannot draw, so there is nobody who may answer,
    // and asking anyway would mean asking the party the user is being
    // protected from.
    if (tier.delegation !== undefined) return {};

    if (tier.viaConnect) {
      const onLocalApproval = this.#options.onLocalApproval;
      const onLocalAsk = this.#options.onLocalAsk;
      return {
        ...(onLocalApproval
          ? {
              decide: (session, summary, call, signal) =>
                this.#decideAtTerminal(onLocalApproval, session, summary, call, signal),
            }
          : {}),
        ...(onLocalAsk
          ? { ask: (session, question, signal) => this.#askAtTerminal(onLocalAsk, session, question, signal) }
          : {}),
      };
    }

    return {
      decide: (session, summary, call, signal) => this.#decideOverWire(session, summary, call, signal),
      ask: (session, question, signal) => this.#askOverWire(session, question, signal),
    };
  }

  /**
   * One consent request, one settlement, and never a hang.
   *
   * The machine every destination runs, written once because it was written
   * twice and the copies diverged: `#ask` armed a deadline on both of its
   * paths, `#requestApproval` armed none on either, and a wallet that accepted
   * an `approval.request` and never answered blocked the agent's turn until a
   * human cancelled it.
   *
   * The deadline is a REQUIRED field for that reason — a channel that forgets
   * one cannot compile — and `unanswered` is required beside it because the
   * two channels decay in opposite directions: a question that nobody answers
   * means "proceed without an answer", and a decision that nobody answers must
   * mean NO. An expiry never grants.
   */
  #awaitConsent<T>(request: {
    session: SessionState;
    /** Registered by the caller BEFORE this runs, so an instant answer cannot
     *  arrive before there is anything to resolve. */
    deferred: Deferred<T>;
    /**
     * Drops the pending registration, and its BOOLEAN is the single-winner
     * interlock. Delete-before-resolve, and letting delete's own result decide,
     * is what makes a replayed answer a no-op and stops a deadline racing an
     * answer into a double resolve.
     */
    settle: () => boolean;
    /** What every non-answer means on this channel. Never a grant. */
    unanswered: T;
    deadlineMs: number;
    /** Logged once, when the deadline rather than a person settled it. */
    deadlineMessage: string;
    /** Puts the request in front of whoever may answer it. */
    send: (settle: () => boolean) => void;
    signal?: AbortSignal | undefined;
  }): Promise<T> {
    const { deferred, settle, signal, unanswered } = request;
    const abort = (): void => {
      if (settle()) deferred.resolve(unanswered);
    };
    const timer = setTimeout(() => {
      if (settle()) {
        this.#log.info(request.deadlineMessage, { sessionId: request.session.id });
        deferred.resolve(unanswered);
      }
    }, request.deadlineMs);

    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    if (!signal?.aborted) request.send(settle);
    return deferred.promise.finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    });
  }

  /** The agent's question, to the client that holds the user's own key. */
  #askOverWire(
    session: SessionState,
    question: AskQuestion,
    signal?: AbortSignal,
  ): Promise<AskAnswers | undefined> {
    const id = randomId('ask_');
    const deferred = new Deferred<AskAnswers | undefined>();
    session.asks.set(id, deferred);
    return this.#awaitConsent<AskAnswers | undefined>({
      session,
      deferred,
      settle: () => session.asks.delete(id),
      unanswered: undefined,
      deadlineMs: ASK_TIMEOUT_MS,
      deadlineMessage: 'nobody answered the agent; proceeding as skipped',
      signal,
      send: () => {
        this.#sendSession(session, {
          t: 'ask',
          s: session.id,
          id,
          message: this.#bounded(question.message, MAX_DESCRIPTION_CHARS, 'ask.message', session.id),
          fields: question.fields,
        });
      },
    });
  }

  /** The agent's question, to the daemon owner's own terminal (ADR-024 R12). */
  #askAtTerminal(
    onLocalAsk: NonNullable<DaemonOptions['onLocalAsk']>,
    session: SessionState,
    question: AskQuestion,
    signal?: AbortSignal,
  ): Promise<AskAnswers | undefined> {
    const deferred = new Deferred<AskAnswers | undefined>();
    // No map entry to drop, so the interlock is a flag — the same interlock
    // for the same reason: whoever flips it first owns the settlement.
    let open = true;
    return this.#awaitConsent<AskAnswers | undefined>({
      session,
      deferred,
      settle: () => {
        const first = open;
        open = false;
        return first;
      },
      unanswered: undefined,
      deadlineMs: ASK_TIMEOUT_MS,
      deadlineMessage: 'nobody answered the agent at the terminal; proceeding as skipped',
      signal,
      send: (settle) => {
        onLocalAsk(question).then(
          (answers) => {
            if (settle()) deferred.resolve(answers);
          },
          (err: unknown) => {
            this.#log.error('the local ask surface failed; proceeding as skipped', {
              sessionId: session.id,
              err,
            });
            if (settle()) deferred.resolve(undefined);
          },
        );
      },
    });
  }

  /** An own-tool decision, to the client that holds the user's own key. */
  #decideOverWire(
    session: SessionState,
    summary: string,
    call?: ApprovalCall,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const id = randomId('appr_');
    const deferred = new Deferred<boolean>();
    const callHash = call ? hashCall(call) : undefined;
    session.approvals.set(id, { decision: deferred, ...(callHash ? { callHash } : {}) });
    return this.#awaitConsent<boolean>({
      session,
      deferred,
      settle: () => session.approvals.delete(id),
      unanswered: false,
      deadlineMs: this.#options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      deadlineMessage: 'nobody answered the approval in time; proceeding as declined',
      signal,
      send: () => {
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
      },
    });
  }

  /** An own-tool decision, at the daemon owner's own terminal. */
  #decideAtTerminal(
    onLocalApproval: NonNullable<DaemonOptions['onLocalApproval']>,
    session: SessionState,
    summary: string,
    call?: ApprovalCall,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deferred = new Deferred<boolean>();
    let open = true;
    return this.#awaitConsent<boolean>({
      session,
      deferred,
      settle: () => {
        const first = open;
        open = false;
        return first;
      },
      unanswered: false,
      deadlineMs: this.#options.approvalTimeoutMs ?? APPROVAL_TIMEOUT_MS,
      deadlineMessage: 'nobody answered the approval at the terminal; proceeding as declined',
      signal,
      send: (settle) => {
        onLocalApproval('runtime_own_tool', summary, call).then(
          (granted) => {
            if (settle()) deferred.resolve(granted);
          },
          (err: unknown) => {
            // Fail closed and SAY so. This path used to hand the rejection to
            // the runtime, which is a turn destroyed by a broken consent
            // surface rather than a call refused by one.
            this.#log.error('the local approval surface failed; refusing the agent its own tool', {
              sessionId: session.id,
              err,
            });
            if (settle()) deferred.resolve(false);
          },
        );
      },
    });
  }

  /**
   * One question, one answer, and never a hang.
   *
   * Resolves `undefined` for every non-answer — skipped, aborted, timed out,
   * no surface that may answer. That is the ACP semantic too: declining means
   * the tool runs with no answers and the model is told the user skipped,
   * while cancelling aborts the turn. An unanswered question must decay into
   * the first, not the second: losing the user's work because nobody clicked
   * is a worse failure than proceeding without an answer.
   *
   * The absent destination is what refuses, so this is not a second lock on a
   * door the policy already closed — it IS the door. The capability
   * declaration is what SHOULD stop a request getting this far (a runtime that
   * sees `mayAsk` false never advertises the tool, ADR-024 R2), but that is
   * the runtime honouring a policy and this is the daemon: a runtime that
   * ignored it, or one we did not write, would otherwise put a question on a
   * tier where the PAGE answers it, and the answer would arrive carrying the
   * user's authority while being authored by the site.
   */
  #ask(
    session: SessionState,
    question: AskQuestion,
    signal?: AbortSignal,
  ): Promise<AskAnswers | undefined> {
    const ask = session.routing.ask;
    if (!ask) {
      this.#log.warn('runtime asked on an attachment with no trusted answer surface; declining', {
        sessionId: session.id,
      });
      return Promise.resolve(undefined);
    }
    return ask(session, question, signal);
  }

  /**
   * One decision, and never a standing yes.
   *
   * Everything reaching this method is the agent's OWN capability — the domain
   * the destinations stamp is a constant for that reason — so this is where
   * ADR-024 R11 lands: a page may answer for its own capability, never for the
   * user's, and never as the user.
   *
   * REFUSAL, not a reroute, and the refusal is the ABSENT destination. The
   * delegated tier has no surface that could answer this: a wallet-origin
   * popup needs a user gesture the agent does not have mid-turn, and a
   * cross-origin frame the page can cover is not a consent surface. Refusing
   * costs one synchronous return and cannot hang — the caller gets the same
   * `false` a human decline produces, which every runtime already handles —
   * and unlike the bare `return false` this replaces, it says so out loud.
   */
  #requestApproval(
    session: SessionState,
    summary: string,
    call?: ApprovalCall,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const decide = session.routing.decide;
    if (!decide) {
      this.#log.warn('refused an own-tool approval: this attachment has no surface that may answer for the user', {
        sessionId: session.id,
        data: { origin: session.surface.origin, delegated: session.delegation !== undefined },
      });
      return Promise.resolve(false);
    }
    return decide(session, summary, call, signal);
  }

  /**
   * `boundString` plus the log line it deliberately cannot write. Only lengths
   * are logged: runtime error messages can embed tool output, which is hostile
   * data, not log material — and the field name comes from us, never from the
   * string.
   */
  #bounded(value: string, max: number, field: string, sessionId?: string): string {
    const bounded = boundString(value, max);
    if (bounded.truncated) {
      this.#log.warn('outbound string truncated to wire bound', {
        ...(sessionId ? { sessionId } : {}),
        data: { field, max, length: value.length },
      });
    }
    return bounded.value;
  }

  /**
   * Conversation content is never truncated silently: `textChunks` splits an
   * oversized runtime chunk across frames instead, and this is the half that
   * knows where a frame goes.
   */
  #streamText(session: SessionState, t: 'delta' | 'thought', promptId: string, text: string): void {
    if (text.length > MAX_TEXT_CHARS) {
      this.#log.info('splitting oversized runtime text across frames', {
        sessionId: session.id,
        data: { type: t, length: text.length, frames: Math.ceil(text.length / MAX_TEXT_CHARS) },
      });
    }
    for (const chunk of textChunks(text)) {
      this.#sendSession(session, { t, s: session.id, promptId, text: chunk });
    }
  }

  /**
   * `boundHistory` plus the log line it deliberately cannot write: what was cut
   * is the session's business, and counts are the only safe rendering of it.
   */
  #boundedHistory(sessionId: string, source: HistoryEntry[]): { entries: HistoryEntry[]; truncated: boolean } {
    const bounded = boundHistory(source);
    const { dropped, truncatedTexts, unknownTimestamps } = bounded.counts;
    if (truncatedTexts > 0 || unknownTimestamps > 0 || dropped > 0) {
      this.#log.warn('history replay bounded for the wire', { sessionId, data: bounded.counts });
    }
    return { entries: bounded.entries, truncated: bounded.truncated };
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
