import {
  PROTOCOL_VERSION,
  authChallengeMessage,
  createLogger,
  decodeFrame,
  isSessionFrame,
  mayOriginate,
  pairingCode,
  randomBytes,
  toErr,
  toHex,
  verify,
  verifyCert,
  verifyDelegation,
  type AgentCert,
  type AgentSummary,
  randomId,
  type CapabilityGrant,
  type Frame,
  type Hex,
  type Logger,
  type LogSink,
  type Role,
  type SurfaceDescriptor,
} from '@agentport/protocol';

const PAIRING_TTL_MS = 5 * 60 * 1000;
/** Long enough to switch to a terminal or phone and read a code out loud. */
const CONNECT_TTL_MS = 3 * 60 * 1000;
/** Guess limit, per connection, for connect-code claims. */
const MAX_CLAIM_ATTEMPTS = 20;
/** A resume the daemon never answers must not leak the waiter forever. */
const PENDING_RESUME_TTL_MS = 30 * 1000;
/**
 * ADR-016 rung A: the relay is stateless about everything durable. Sessions
 * are live-socket routing entries and nothing more — no tokens (the daemon
 * mints and checks them), no grants or surfaces (the daemon holds them), no
 * certs (verified at connection time, stored at the edges). A relay restart
 * loses only sockets, and both ends redial.
 */

/** A connected socket, whatever the runtime's socket actually is. */
export interface Peer {
  send(frame: Frame): void;
  close(): void;
}

interface Conn {
  peer: Peer;
  nonce: string;
  role?: Role;
  pubkey?: Hex;
  authed: boolean;
  bound: boolean;
  announce?: { name: string; runtime: string; location?: string };
  /**
   * The agent's ownership cert, verified at identify time. Lives and dies
   * with the socket — the relay stores nothing (ADR-016).
   */
  cert?: AgentCert;
  sessions: Set<string>;
  /** Failed guesses, so a socket cannot brute-force a connect code. */
  claimAttempts: number;
}

/** Pure routing: which two sockets may speak on this id. Nothing else. */
interface Session {
  id: string;
  client: Conn | undefined;
  agent: Conn;
}

interface Pending {
  code: string;
  agentPubkey: Hex;
  conn: Conn;
  expiresAt: number;
}

/** A drop-in widget waiting for some agent's owner to accept it. */
interface PendingConnect {
  code: string;
  conn: Conn;
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  expiresAt: number;
  /** The page's ephemeral sealing key, carried through to the session.open. */
  epk: Hex;
  epkSig: Hex;
}

export interface RelayCoreOptions {
  sink?: LogSink;
  now?: () => number;
}

/**
 * All relay behaviour, with no I/O and (ADR-016) no durable state.
 *
 * Node (`ws`) and Cloudflare (Durable Object) both wrap this. Everything the
 * relay is allowed to do is in this file — if it isn't here, the relay can't
 * do it, and if it isn't a live socket, the relay doesn't know it.
 */
export class RelayCore {
  #conns = new Set<Conn>();
  #byPeer = new Map<Peer, Conn>();
  #agents = new Map<Hex, Conn>();
  #sessions = new Map<string, Session>();
  #pending = new Map<string, Pending>();
  #connects = new Map<string, PendingConnect>();
  /** Clients whose resume is in flight to a daemon, keyed by session id. */
  #pendingResumes = new Map<string, { conn: Conn; at: number }>();
  #log: Logger;
  #now: () => number;

  constructor(options: RelayCoreOptions = {}) {
    this.#log = createLogger('relay.core', { sink: options.sink });
    this.#now = options.now ?? (() => Date.now());
  }

  // --- lifecycle -----------------------------------------------------------

  open(peer: Peer): void {
    const conn: Conn = {
      peer,
      nonce: toHex(randomBytes(16)),
      authed: false,
      bound: false,
      sessions: new Set(),
      claimAttempts: 0,
    };
    this.#conns.add(conn);
    this.#byPeer.set(peer, conn);
  }

  message(peer: Peer, data: string): void {
    const conn = this.#byPeer.get(peer);
    if (!conn) return;
    let frame: Frame;
    try {
      frame = decodeFrame(data);
    } catch (err) {
      this.#log.warn('rejected undecodable frame', { err });
      return this.#fail(conn, 'bad_frame', 'could not parse frame');
    }
    try {
      this.#onFrame(conn, frame);
    } catch (err) {
      this.#log.error('frame handler failed', {
        err,
        data: { frameType: frame.t, role: conn.role, peer: conn.pubkey?.slice(0, 8) },
      });
      this.#fail(conn, 'internal', toErr(err).message);
    }
  }

  close(peer: Peer): void {
    const conn = this.#byPeer.get(peer);
    if (!conn) return;
    this.#byPeer.delete(peer);
    this.#conns.delete(conn);

    for (const id of conn.sessions) {
      const session = this.#sessions.get(id);
      if (!session) continue;

      if (session.client === conn) {
        // A page refresh looks exactly like this. Tell the daemon its client
        // detached; the DAEMON holds the session through its own grace period
        // and counts what was missed. The relay keeps only the routing entry.
        session.client = undefined;
        session.agent.peer.send({ t: 'session.detach', s: id });
        continue;
      }

      // The agent going away is terminal — there is nothing to resume to.
      session.client?.sessions.delete(id);
      session.client?.peer.send({ t: 'session.close', s: id, reason: 'agent_disconnected' });
      this.#sessions.delete(id);
    }

    for (const [code, pending] of this.#pending) {
      if (pending.conn === conn) this.#pending.delete(code);
    }
    for (const [code, connect] of this.#connects) {
      if (connect.conn === conn) this.#connects.delete(code);
    }

    if (conn.role === 'agent' && conn.pubkey && this.#agents.get(conn.pubkey) === conn) {
      this.#agents.delete(conn.pubkey);
      if (conn.cert) this.#broadcastPresence(conn.cert.user, conn.pubkey, false);
      this.#log.info('agent offline', { data: { agent: conn.pubkey.slice(0, 8) } });
    }
  }

  // -------------------------------------------------------------------------

  #fail(conn: Conn, code: string, message: string, ref?: string): void {
    conn.peer.send({ t: 'error', code, message, ...(ref ? { ref } : {}) });
  }

  #onFrame(conn: Conn, frame: Frame): void {
    if (frame.t === 'hello') {
      if (frame.v !== PROTOCOL_VERSION) {
        return this.#fail(conn, 'version', `relay speaks ${PROTOCOL_VERSION}`);
      }
      conn.role = frame.role;
      return conn.peer.send({ t: 'challenge', nonce: conn.nonce });
    }

    if (frame.t === 'identify') return this.#onIdentify(conn, frame);

    if (!conn.authed || !conn.pubkey || !conn.role) {
      return this.#fail(conn, 'unauthenticated', 'send hello + identify first');
    }

    if (isSessionFrame(frame)) return this.#route(conn, frame);

    switch (frame.t) {
      case 'pair.begin':
        return this.#onPairBegin(conn);
      case 'pair.claim':
        return this.#onPairClaim(conn, frame.code);
      case 'pair.complete':
        return this.#onPairComplete(conn, frame.code, frame.cert);
      case 'connect.begin':
        return this.#onConnectBegin(conn, frame);
      case 'connect.claim':
        return this.#onConnectClaim(conn, frame.code);
      case 'connect.accept':
        return this.#onConnectAccept(conn, frame.code);
      case 'connect.reject':
        return this.#onConnectReject(conn, frame.code, frame.reason);
      case 'agents.list':
        return conn.peer.send({ t: 'agents', agents: this.#agentsFor(conn.pubkey) });
      default:
        return this.#fail(conn, 'unexpected', `relay does not accept ${frame.t}`);
    }
  }

  #onIdentify(conn: Conn, frame: Extract<Frame, { t: 'identify' }>): void {
    if (!conn.role) return this.#fail(conn, 'sequence', 'hello must precede identify');
    if (!verify(frame.pubkey, authChallengeMessage(conn.nonce), frame.sig)) {
      return this.#fail(conn, 'auth', 'challenge signature did not verify');
    }

    conn.pubkey = frame.pubkey;
    conn.authed = true;

    if (conn.role === 'agent') {
      // The cert is presented, verified, and held for this socket's lifetime —
      // never stored (ADR-016). An agent that reconnects presents it again.
      const cert = frame.cert;
      if (cert && (cert.agent !== frame.pubkey || !verifyCert(cert))) {
        return this.#fail(conn, 'cert', 'cert does not match this agent key');
      }

      conn.cert = cert;
      conn.bound = Boolean(cert);
      conn.announce =
        frame.announce ??
        (cert ? { name: cert.name, runtime: cert.runtime, location: cert.location } : undefined);

      const existing = this.#agents.get(frame.pubkey);
      if (existing && existing !== conn) existing.peer.close();
      this.#agents.set(frame.pubkey, conn);

      conn.peer.send({ t: 'ready', role: 'agent', pubkey: frame.pubkey, bound: conn.bound });
      if (cert) this.#broadcastPresence(cert.user, frame.pubkey, true);
      this.#log.info('agent online', { data: { agent: frame.pubkey.slice(0, 8), bound: conn.bound } });
      return;
    }

    conn.peer.send({ t: 'ready', role: 'client', pubkey: frame.pubkey });
  }

  // --- pairing -------------------------------------------------------------

  #onPairBegin(conn: Conn): void {
    if (conn.role !== 'agent') return this.#fail(conn, 'role', 'only agents may begin pairing');
    this.#sweepPending();
    const code = pairingCode();
    const expiresAt = this.#now() + PAIRING_TTL_MS;
    this.#pending.set(code, { code, agentPubkey: conn.pubkey!, conn, expiresAt });
    conn.peer.send({ t: 'pair.pending', code, expiresAt });
  }

  #onPairClaim(conn: Conn, code: string): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only wallets may claim codes');
    this.#sweepPending();
    const pending = this.#pending.get(code);
    if (!pending) return this.#fail(conn, 'pair_unknown', 'unknown or expired pairing code', code);
    conn.peer.send({
      t: 'pair.offer',
      code,
      agent: {
        pubkey: pending.agentPubkey,
        name: pending.conn.announce?.name ?? 'Unnamed agent',
        runtime: pending.conn.announce?.runtime ?? 'unknown',
        location: pending.conn.announce?.location,
      },
    });
  }

  #onPairComplete(conn: Conn, code: string, cert: AgentCert): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only wallets may complete pairing');
    const pending = this.#pending.get(code);
    if (!pending) return this.#fail(conn, 'pair_unknown', 'unknown or expired pairing code', code);
    if (cert.agent !== pending.agentPubkey) {
      return this.#fail(conn, 'pair_mismatch', 'cert names a different agent', code);
    }
    if (cert.user !== conn.pubkey) {
      return this.#fail(conn, 'pair_mismatch', 'cert must be signed by the claiming user', code);
    }
    if (!verifyCert(cert)) return this.#fail(conn, 'pair_sig', 'cert signature did not verify', code);

    this.#pending.delete(code);
    pending.conn.bound = true;
    pending.conn.cert = cert;

    pending.conn.peer.send({ t: 'pair.bound', cert });
    conn.peer.send({ t: 'pair.bound', cert });
    this.#log.info('agent paired', {
      data: { agent: cert.agent.slice(0, 8), user: cert.user.slice(0, 8) },
    });
  }

  #sweepPending(): void {
    const now = this.#now();
    for (const [code, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(code);
    }
  }

  // --- drop-in connect -----------------------------------------------------

  #sweepConnects(): void {
    const now = this.#now();
    for (const [code, connect] of this.#connects) {
      if (connect.expiresAt <= now) {
        connect.conn.peer.send({ t: 'connect.denied', code, reason: 'expired' });
        this.#connects.delete(code);
      }
    }
  }

  #onConnectBegin(conn: Conn, frame: Extract<Frame, { t: 'connect.begin' }>): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only clients may request a connection');
    if (!frame.epk || !frame.epkSig) {
      return this.#fail(conn, 'sealing_required', 'connect requests require a sealing-key proof');
    }
    this.#sweepConnects();
    const code = pairingCode();
    const expiresAt = this.#now() + CONNECT_TTL_MS;
    this.#connects.set(code, {
      code,
      conn,
      surface: frame.surface,
      grant: frame.grant,
      expiresAt,
      epk: frame.epk,
      epkSig: frame.epkSig,
    });
    conn.peer.send({ t: 'connect.pending', code, expiresAt });
  }

  #onConnectClaim(conn: Conn, code: string): void {
    if (conn.role !== 'agent') return this.#fail(conn, 'role', 'only agents may claim a connect code');
    this.#sweepConnects();
    if (++conn.claimAttempts > MAX_CLAIM_ATTEMPTS) {
      return this.#fail(conn, 'rate_limited', 'too many connect-code attempts', code);
    }
    const connect = this.#connects.get(code);
    if (!connect) return this.#fail(conn, 'connect_unknown', 'unknown or expired connect code', code);
    conn.claimAttempts = 0;
    // Show the agent exactly what is being asked for, before anyone consents.
    // The client identity and epk ride along so the consent screen can show
    // the fingerprint words before anything is approved.
    conn.peer.send({
      t: 'connect.offer',
      code,
      surface: connect.surface,
      grant: connect.grant,
      client: connect.conn.pubkey!,
      epk: connect.epk,
      epkSig: connect.epkSig,
    });
  }

  #onConnectAccept(conn: Conn, code: string): void {
    if (conn.role !== 'agent') return this.#fail(conn, 'role', 'only agents may accept a connection');
    this.#sweepConnects();
    const connect = this.#connects.get(code);
    if (!connect) return this.#fail(conn, 'connect_unknown', 'unknown or expired connect code', code);
    this.#connects.delete(code);

    if (connect.grant.expiresAt <= this.#now()) {
      return connect.conn.peer.send({ t: 'connect.denied', code, reason: 'grant_expired' });
    }

    // From here it is an ordinary session: the agent will answer the
    // synthesised session.open with session.opened, which routes back to the
    // widget through the normal path.
    const id = randomId('sess_');
    this.#sessions.set(id, { id, client: connect.conn, agent: conn });
    connect.conn.sessions.add(id);
    conn.sessions.add(id);

    conn.peer.send({
      t: 'session.open',
      s: id,
      agent: conn.pubkey!,
      surface: connect.surface,
      grant: connect.grant,
      client: connect.conn.pubkey!,
      viaConnect: true,
      epk: connect.epk,
      epkSig: connect.epkSig,
    });
    this.#log.info('connect request accepted', {
      sessionId: id,
      data: { code, agent: conn.pubkey!.slice(0, 8) },
    });
  }

  #onConnectReject(conn: Conn, code: string, reason: string): void {
    if (conn.role !== 'agent') return this.#fail(conn, 'role', 'only agents may reject a connection');
    const connect = this.#connects.get(code);
    if (!connect) return;
    this.#connects.delete(code);
    connect.conn.peer.send({ t: 'connect.denied', code, reason });
  }

  // --- directory -----------------------------------------------------------

  /**
   * Live connections only. The wallet holds the durable directory (it signed
   * the certs); the relay can only ever say who is HERE, and that is all it
   * should know.
   */
  #agentsFor(user: Hex): AgentSummary[] {
    const rows: AgentSummary[] = [];
    for (const conn of this.#agents.values()) {
      const cert = conn.cert;
      if (!cert || cert.user !== user) continue;
      rows.push({ agent: cert.agent, name: cert.name, runtime: cert.runtime, location: cert.location, online: true });
    }
    return rows;
  }

  #broadcastPresence(user: Hex, agent: Hex, online: boolean): void {
    for (const conn of this.#conns) {
      if (conn.role === 'client' && conn.authed && conn.pubkey === user) {
        conn.peer.send({ t: 'agents.presence', agent, online });
      }
    }
  }

  // --- session routing -----------------------------------------------------

  #route(conn: Conn, frame: Extract<Frame, { s: string }>): void {
    if (frame.t === 'session.open') return this.#openSession(conn, frame);
    if (frame.t === 'session.resume') return this.#resumeSession(conn, frame);

    const session = this.#sessions.get(frame.s);

    // The daemon answers a resume with session.resumed (or a denial): bind the
    // waiting client into the routing entry at that moment. The relay makes no
    // judgement — the daemon minted the token and already made it.
    if (conn.role === 'agent' && (frame.t === 'session.resumed' || frame.t === 'session.denied')) {
      const waiting = this.#takePendingResume(frame.s);
      if (waiting) {
        if (frame.t === 'session.resumed') {
          const existing = session;
          if (existing && existing.agent !== conn) {
            return this.#fail(conn, 'forbidden', 'not a participant in this session', frame.s);
          }
          // A stale client socket the daemon has already ruled dead gets told.
          if (existing?.client && existing.client !== waiting.conn) {
            existing.client.sessions.delete(frame.s);
            existing.client.peer.send({ t: 'session.close', s: frame.s, reason: 'resumed_elsewhere' });
          }
          this.#sessions.set(frame.s, { id: frame.s, client: waiting.conn, agent: conn });
          waiting.conn.sessions.add(frame.s);
          conn.sessions.add(frame.s);
        }
        waiting.conn.peer.send(frame);
        return;
      }
    }

    if (!session) return this.#fail(conn, 'no_session', 'unknown session', frame.s);
    if (session.client !== conn && session.agent !== conn) {
      return this.#fail(conn, 'forbidden', 'not a participant in this session', frame.s);
    }
    if (!mayOriginate(conn.role!, frame.t)) {
      return this.#fail(conn, 'forbidden', `a ${conn.role} may not send ${frame.t}`, frame.s);
    }

    if (session.agent === conn) {
      // The agent identity stamp on session.opened lets a drop-in client
      // (which chose no agent and knows none) verify the epk proof rather
      // than trusting the relay outright. Tokens are the daemon's business.
      const outbound: Frame = frame.t === 'session.opened' ? { ...frame, agent: conn.pubkey! } : frame;
      if (session.client) session.client.peer.send(outbound);
      // No client attached: drop. The daemon counts its own misses.
    } else {
      session.agent.peer.send(frame);
    }

    if (frame.t === 'session.close') {
      session.client?.sessions.delete(session.id);
      session.agent.sessions.delete(session.id);
      this.#sessions.delete(session.id);
    }
  }

  #takePendingResume(id: string): { conn: Conn; at: number } | undefined {
    const entry = this.#pendingResumes.get(id);
    this.#pendingResumes.delete(id);
    if (!entry) return undefined;
    if (this.#now() - entry.at > PENDING_RESUME_TTL_MS) return undefined;
    return this.#conns.has(entry.conn) ? entry : undefined;
  }

  /**
   * The relay's whole role in a resume: find the named agent's live socket,
   * stamp the resumer's authenticated identity, forward, and remember who to
   * answer. The daemon minted the token; the daemon rules on it.
   */
  #resumeSession(conn: Conn, frame: Extract<Frame, { t: 'session.resume' }>): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only clients resume', frame.s);

    const agentConn = this.#agents.get(frame.agent);
    if (!agentConn) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'agent_offline' });
    }

    this.#pendingResumes.set(frame.s, { conn, at: this.#now() });
    agentConn.peer.send({ ...frame, client: conn.pubkey! });
  }

  #openSession(conn: Conn, frame: Extract<Frame, { t: 'session.open' }>): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only clients open sessions', frame.s);

    const agentConn = this.#agents.get(frame.agent);
    if (!agentConn) return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'agent_offline' });
    // Ownership is judged only from live, presented proofs: either the
    // connected client is the cert's user, or that user signed a still-live
    // delegation to this exact authenticated client key. The daemon repeats
    // the delegation chain independently; nothing here consults storage.
    const cert = agentConn.cert;
    const delegation = frame.delegation;
    const directlyOwned = cert?.user === conn.pubkey;
    const delegated = Boolean(
      cert &&
        delegation &&
        verifyDelegation(cert.user, delegation) &&
        delegation.delegate === conn.pubkey &&
        delegation.agent === agentConn.pubkey &&
        typeof delegation.expiresAt === 'number' &&
        Number.isFinite(delegation.expiresAt) &&
        delegation.expiresAt > this.#now() &&
        // The relay cannot authenticate a browser origin. It preserves the
        // signed value for the daemon to compare with frame.surface.origin.
        typeof delegation.origin === 'string',
    );
    if (!directlyOwned && !delegated) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'not_your_agent' });
    }
    if (this.#sessions.has(frame.s)) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'duplicate_session' });
    }
    if (frame.grant.expiresAt <= this.#now()) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
    }

    const session: Session = { id: frame.s, client: conn, agent: agentConn };
    this.#sessions.set(frame.s, session);
    conn.sessions.add(frame.s);
    agentConn.sessions.add(frame.s);

    // Stamp the authenticated client key so the agent never has to trust a
    // self-reported identity.
    agentConn.peer.send({ ...frame, client: conn.pubkey! });
    this.#log.info('session routed', {
      sessionId: frame.s,
      data: {
        client: conn.pubkey!.slice(0, 8),
        agent: frame.agent.slice(0, 8),
        surface: frame.surface.name,
      },
    });
  }
}
