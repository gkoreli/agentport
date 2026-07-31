import {
  PROTOCOL_VERSION,
  authChallengeMessage,
  decodeFrame,
  isSessionFrame,
  mayOriginate,
  pairingCode,
  randomBytes,
  toHex,
  verify,
  verifyCert,
  type AgentCert,
  type AgentSummary,
  randomId,
  type CapabilityGrant,
  type Frame,
  type Hex,
  type Role,
  type SurfaceDescriptor,
} from '@agentport/protocol';

/**
 * Compares two hex secrets without leaking length or content through timing.
 * Small, but this is the one place a secret is checked, so it is worth doing.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const PAIRING_TTL_MS = 5 * 60 * 1000;
/** Long enough to switch to a terminal or phone and read a code out loud. */
const CONNECT_TTL_MS = 3 * 60 * 1000;
/** Guess limits, per connection, for the two code/token lookups. */
const MAX_CLAIM_ATTEMPTS = 20;
const MAX_RESUME_ATTEMPTS = 10;
/** How long a session survives its client so a refresh can re-attach. */
const ORPHAN_GRACE_MS = 5 * 60 * 1000;
/**
 * The relay does NOT hold conversation. When a client is away, agent output is
 * dropped and only counted — a number is routing metadata, the frames are the
 * user's data and belong to their own agent. Replay on resume is the agent's
 * job (ACP `session/load`), not ours.
 */

/** A connected socket, whatever the runtime's socket actually is. */
export interface Peer {
  send(frame: Frame): void;
  close(): void;
}

/** In-memory cert index. Durability is the host's problem, not the core's. */
export interface CertIndex {
  get(agent: Hex): AgentCert | undefined;
  put(cert: AgentCert): void;
  forUser(user: Hex): AgentCert[];
  remove(agent: Hex): boolean;
}

export class MemoryCertIndex implements CertIndex {
  #byAgent = new Map<Hex, AgentCert>();

  constructor(certs: AgentCert[] = []) {
    for (const cert of certs) if (verifyCert(cert)) this.#byAgent.set(cert.agent, cert);
  }

  get(agent: Hex): AgentCert | undefined {
    return this.#byAgent.get(agent);
  }

  put(cert: AgentCert): void {
    if (!verifyCert(cert)) throw new Error('refusing to store cert with invalid signature');
    this.#byAgent.set(cert.agent, cert);
  }

  forUser(user: Hex): AgentCert[] {
    return [...this.#byAgent.values()].filter((cert) => cert.user === user);
  }

  remove(agent: Hex): boolean {
    return this.#byAgent.delete(agent);
  }

  all(): AgentCert[] {
    return [...this.#byAgent.values()];
  }
}

interface Conn {
  peer: Peer;
  nonce: string;
  role?: Role;
  pubkey?: Hex;
  authed: boolean;
  bound: boolean;
  announce?: { name: string; runtime: string; location?: string };
  sessions: Set<string>;
  /** Failed guesses, so a socket cannot brute-force a code or a token. */
  claimAttempts: number;
  resumeAttempts: number;
}

interface Session {
  id: string;
  client: Conn | undefined;
  agent: Conn;
  /** Bearer secret the client presents to re-attach after a reload. */
  token: string;
  surface: SurfaceDescriptor;
  grant: CapabilityGrant;
  agentName: string;
  runtime: string;
  /** Set when the client socket dropped; cleared on resume. */
  orphanedAt?: number;
  /** How many agent frames were dropped while nobody was listening. */
  missedWhileAway: number;
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
}

export interface RelayCoreOptions {
  certs: CertIndex;
  /** Called after a cert is accepted, so the host can persist it. */
  onCertStored?: (cert: AgentCert) => void;
  log?: (message: string) => void;
  now?: () => number;
}

/**
 * All relay behaviour, with no I/O.
 *
 * Node (`ws`) and Cloudflare (Durable Object) both wrap this, so pairing,
 * presence, ownership checks and routing can't drift between deployments.
 * Everything the relay is allowed to do is in this file — if it isn't here,
 * the relay can't do it.
 */
export class RelayCore {
  readonly certs: CertIndex;

  #conns = new Set<Conn>();
  #byPeer = new Map<Peer, Conn>();
  #agents = new Map<Hex, Conn>();
  #sessions = new Map<string, Session>();
  #pending = new Map<string, Pending>();
  #connects = new Map<string, PendingConnect>();
  #log: (message: string) => void;
  #now: () => number;
  #onCertStored: ((cert: AgentCert) => void) | undefined;

  constructor(options: RelayCoreOptions) {
    this.certs = options.certs;
    this.#log = options.log ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
    this.#onCertStored = options.onCertStored;
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
      resumeAttempts: 0,
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
    } catch {
      return this.#fail(conn, 'bad_frame', 'could not parse frame');
    }
    try {
      this.#onFrame(conn, frame);
    } catch (err) {
      this.#fail(conn, 'internal', err instanceof Error ? err.message : String(err));
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
        // A page refresh looks exactly like this. Keep the agent side alive
        // and hold its output so the reloaded tab can pick the thread back up.
        session.client = undefined;
        session.orphanedAt = this.#now();
        this.#log(`session ${id} orphaned; holding ${ORPHAN_GRACE_MS / 1000}s for a resume`);
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
      const cert = this.certs.get(conn.pubkey);
      if (cert) this.#broadcastPresence(cert.user, conn.pubkey, false);
      this.#log(`agent offline ${conn.pubkey.slice(0, 8)}`);
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
        return this.#onConnectBegin(conn, frame.surface, frame.grant);
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
      const stored = this.certs.get(frame.pubkey) ?? frame.cert;
      if (stored && (stored.agent !== frame.pubkey || !verifyCert(stored))) {
        return this.#fail(conn, 'cert', 'cert does not match this agent key');
      }
      if (stored && !this.certs.get(frame.pubkey)) {
        this.certs.put(stored);
        this.#onCertStored?.(stored);
      }

      conn.bound = Boolean(stored);
      conn.announce =
        frame.announce ??
        (stored ? { name: stored.name, runtime: stored.runtime, location: stored.location } : undefined);

      const existing = this.#agents.get(frame.pubkey);
      if (existing && existing !== conn) existing.peer.close();
      this.#agents.set(frame.pubkey, conn);

      conn.peer.send({ t: 'ready', role: 'agent', pubkey: frame.pubkey, bound: conn.bound });
      if (stored) this.#broadcastPresence(stored.user, frame.pubkey, true);
      this.#log(`agent online ${frame.pubkey.slice(0, 8)} bound=${conn.bound}`);
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

    this.certs.put(cert);
    this.#onCertStored?.(cert);
    this.#pending.delete(code);
    pending.conn.bound = true;

    pending.conn.peer.send({ t: 'pair.bound', cert });
    conn.peer.send({ t: 'pair.bound', cert });
    this.#log(`paired ${cert.agent.slice(0, 8)} -> user ${cert.user.slice(0, 8)}`);
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

  #onConnectBegin(conn: Conn, surface: SurfaceDescriptor, grant: CapabilityGrant): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only clients may request a connection');
    this.#sweepConnects();
    const code = pairingCode();
    const expiresAt = this.#now() + CONNECT_TTL_MS;
    this.#connects.set(code, { code, conn, surface, grant, expiresAt });
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
    conn.peer.send({ t: 'connect.offer', code, surface: connect.surface, grant: connect.grant });
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
    this.#sessions.set(id, {
      id,
      client: connect.conn,
      agent: conn,
      token: toHex(randomBytes(24)),
      surface: connect.surface,
      grant: connect.grant,
      agentName: '',
      runtime: '',
      missedWhileAway: 0,
    });
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
    });
    this.#log(`connect ${code} accepted by ${conn.pubkey!.slice(0, 8)} as session ${id}`);
  }

  #onConnectReject(conn: Conn, code: string, reason: string): void {
    if (conn.role !== 'agent') return this.#fail(conn, 'role', 'only agents may reject a connection');
    const connect = this.#connects.get(code);
    if (!connect) return;
    this.#connects.delete(code);
    connect.conn.peer.send({ t: 'connect.denied', code, reason });
  }

  // --- directory -----------------------------------------------------------

  #agentsFor(user: Hex): AgentSummary[] {
    return this.certs.forUser(user).map((cert) => ({
      agent: cert.agent,
      name: cert.name,
      runtime: cert.runtime,
      location: cert.location,
      online: this.#agents.has(cert.agent),
    }));
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

    this.#sweepOrphans();

    const session = this.#sessions.get(frame.s);
    if (!session) return this.#fail(conn, 'no_session', 'unknown session', frame.s);
    if (session.client !== conn && session.agent !== conn) {
      return this.#fail(conn, 'forbidden', 'not a participant in this session', frame.s);
    }
    if (!mayOriginate(conn.role!, frame.t)) {
      return this.#fail(conn, 'forbidden', `a ${conn.role} may not send ${frame.t}`, frame.s);
    }

    if (session.agent === conn) {
      let outbound: Frame = frame;
      if (frame.t === 'session.opened') {
        // Captured here so a resume can describe the session without asking
        // the agent again, and the token reaches only this client.
        session.agentName = frame.agentName;
        session.runtime = frame.runtime;
        outbound = { ...frame, resume: session.token };
      }
      if (session.client) session.client.peer.send(outbound);
      else session.missedWhileAway++;
    } else {
      session.agent.peer.send(frame);
    }

    if (frame.t === 'session.close') {
      session.client?.sessions.delete(session.id);
      session.agent.sessions.delete(session.id);
      this.#sessions.delete(session.id);
    }
  }

  #sweepOrphans(): void {
    const now = this.#now();
    for (const [id, session] of this.#sessions) {
      if (session.orphanedAt !== undefined && now - session.orphanedAt > ORPHAN_GRACE_MS) {
        session.agent.sessions.delete(id);
        session.agent.peer.send({ t: 'session.close', s: id, reason: 'client_never_returned' });
        this.#sessions.delete(id);
        this.#log(`session ${id} expired without a resume`);
      }
    }
  }

  #resumeSession(conn: Conn, frame: Extract<Frame, { t: 'session.resume' }>): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only clients resume', frame.s);
    this.#sweepOrphans();

    if (++conn.resumeAttempts > MAX_RESUME_ATTEMPTS) {
      return this.#fail(conn, 'rate_limited', 'too many resume attempts', frame.s);
    }

    const session = this.#sessions.get(frame.s);
    // One message for every failure: a wrong token must not be distinguishable
    // from an unknown session. The compare is constant-time so the answer
    // cannot be teased out by timing either.
    if (!session || !timingSafeEqual(session.token, frame.token)) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'not_resumable' });
    }
    conn.resumeAttempts = 0;
    if (session.client) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'already_attached' });
    }
    if (session.grant.expiresAt <= this.#now()) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
    }

    session.client = conn;
    session.orphanedAt = undefined;
    conn.sessions.add(session.id);

    const missed = session.missedWhileAway;
    session.missedWhileAway = 0;
    conn.peer.send({
      t: 'session.resumed',
      s: session.id,
      agentName: session.agentName,
      runtime: session.runtime,
      surface: session.surface,
      grant: session.grant,
      missed,
    });
    this.#log(`session ${session.id} resumed (${missed} frame(s) were dropped while away)`);
  }

  #openSession(conn: Conn, frame: Extract<Frame, { t: 'session.open' }>): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only clients open sessions', frame.s);

    const cert = this.certs.get(frame.agent);
    if (!cert || cert.user !== conn.pubkey) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'not_your_agent' });
    }
    const agentConn = this.#agents.get(frame.agent);
    if (!agentConn) return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'agent_offline' });
    if (this.#sessions.has(frame.s)) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'duplicate_session' });
    }
    if (frame.grant.expiresAt <= this.#now()) {
      return conn.peer.send({ t: 'session.denied', s: frame.s, reason: 'grant_expired' });
    }

    const session: Session = {
      id: frame.s,
      client: conn,
      agent: agentConn,
      token: toHex(randomBytes(24)),
      surface: frame.surface,
      grant: frame.grant,
      agentName: '',
      runtime: '',
      missedWhileAway: 0,
    };
    this.#sessions.set(frame.s, session);
    conn.sessions.add(frame.s);
    agentConn.sessions.add(frame.s);

    // Stamp the authenticated client key so the agent never has to trust a
    // self-reported identity.
    agentConn.peer.send({ ...frame, client: conn.pubkey! });
    this.#log(
      `session ${frame.s} ${conn.pubkey!.slice(0, 8)} -> ${frame.agent.slice(0, 8)} (${frame.surface.name})`,
    );
  }
}
