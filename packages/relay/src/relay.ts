import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  authChallengeMessage,
  decodeFrame,
  encodeFrame,
  isSessionFrame,
  mayOriginate,
  pairingCode,
  randomId,
  toHex,
  randomBytes,
  verify,
  verifyCert,
  type AgentCert,
  type AgentSummary,
  type Frame,
  type Hex,
  type Role,
} from '@agentport/protocol';
import { CertStore } from './store.js';

const PAIRING_TTL_MS = 5 * 60 * 1000;

interface Conn {
  socket: WebSocket;
  nonce: string;
  role?: Role;
  pubkey?: Hex;
  authed: boolean;
  /** Agents only: has a stored, valid cert. */
  bound: boolean;
  announce?: { name: string; runtime: string; location?: string };
  sessions: Set<string>;
}

interface Session {
  id: string;
  client: Conn;
  agent: Conn;
}

interface Pending {
  code: string;
  agentPubkey: Hex;
  conn: Conn;
  expiresAt: number;
}

export interface RelayOptions {
  port?: number;
  host?: string;
  storePath?: string;
  log?: (message: string) => void;
}

export class Relay {
  readonly certs: CertStore;
  #wss: WebSocketServer;
  #conns = new Set<Conn>();
  #agents = new Map<Hex, Conn>();
  #sessions = new Map<string, Session>();
  #pending = new Map<string, Pending>();
  #log: (message: string) => void;

  constructor(options: RelayOptions = {}) {
    this.certs = new CertStore(options.storePath);
    this.#log = options.log ?? (() => {});
    this.#wss = new WebSocketServer({ port: options.port ?? 8787, host: options.host ?? '127.0.0.1' });
    this.#wss.on('connection', (socket) => this.#onConnection(socket));
  }

  get port(): number {
    const address = this.#wss.address();
    return typeof address === 'object' && address ? address.port : 0;
  }

  async listening(): Promise<void> {
    if (this.#wss.address()) return;
    await new Promise<void>((resolve, reject) => {
      this.#wss.once('listening', resolve);
      this.#wss.once('error', reject);
    });
  }

  async close(): Promise<void> {
    for (const conn of this.#conns) conn.socket.close();
    await new Promise<void>((resolve, reject) =>
      this.#wss.close((err) => (err ? reject(err) : resolve())),
    );
  }

  // -------------------------------------------------------------------------

  #onConnection(socket: WebSocket): void {
    const conn: Conn = {
      socket,
      nonce: toHex(randomBytes(16)),
      authed: false,
      bound: false,
      sessions: new Set(),
    };
    this.#conns.add(conn);

    socket.on('message', (data) => {
      let frame: Frame;
      try {
        frame = decodeFrame(data.toString());
      } catch {
        return this.#fail(conn, 'bad_frame', 'could not parse frame');
      }
      try {
        this.#onFrame(conn, frame);
      } catch (err) {
        this.#fail(conn, 'internal', err instanceof Error ? err.message : String(err));
      }
    });

    socket.on('close', () => this.#onClose(conn));
    socket.on('error', () => this.#onClose(conn));
  }

  #onClose(conn: Conn): void {
    if (!this.#conns.delete(conn)) return;

    for (const id of conn.sessions) {
      const session = this.#sessions.get(id);
      if (!session) continue;
      const other = session.client === conn ? session.agent : session.client;
      other.sessions.delete(id);
      this.#send(other, { t: 'session.close', s: id, reason: 'peer_disconnected' });
      this.#sessions.delete(id);
    }

    for (const [code, pending] of this.#pending) {
      if (pending.conn === conn) this.#pending.delete(code);
    }

    if (conn.role === 'agent' && conn.pubkey && this.#agents.get(conn.pubkey) === conn) {
      this.#agents.delete(conn.pubkey);
      const cert = this.certs.get(conn.pubkey);
      if (cert) this.#broadcastPresence(cert.user, conn.pubkey, false);
      this.#log(`agent offline ${conn.pubkey.slice(0, 8)}`);
    }
  }

  #send(conn: Conn, frame: Frame): void {
    if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(encodeFrame(frame));
  }

  #fail(conn: Conn, code: string, message: string, ref?: string): void {
    this.#send(conn, { t: 'error', code, message, ...(ref ? { ref } : {}) });
  }

  // -------------------------------------------------------------------------

  #onFrame(conn: Conn, frame: Frame): void {
    if (frame.t === 'hello') {
      if (frame.v !== PROTOCOL_VERSION) {
        return this.#fail(conn, 'version', `relay speaks ${PROTOCOL_VERSION}`);
      }
      conn.role = frame.role;
      return this.#send(conn, { t: 'challenge', nonce: conn.nonce });
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
      case 'agents.list':
        return this.#send(conn, { t: 'agents', agents: this.#agentsFor(conn.pubkey) });
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
      if (stored && !this.certs.get(frame.pubkey)) this.certs.put(stored);

      conn.bound = Boolean(stored);
      conn.announce = frame.announce ??
        (stored ? { name: stored.name, runtime: stored.runtime, location: stored.location } : undefined);

      const existing = this.#agents.get(frame.pubkey);
      if (existing && existing !== conn) existing.socket.close();
      this.#agents.set(frame.pubkey, conn);

      this.#send(conn, { t: 'ready', role: 'agent', pubkey: frame.pubkey, bound: conn.bound });
      if (stored) this.#broadcastPresence(stored.user, frame.pubkey, true);
      this.#log(`agent online ${frame.pubkey.slice(0, 8)} bound=${conn.bound}`);
      return;
    }

    this.#send(conn, { t: 'ready', role: 'client', pubkey: frame.pubkey });
  }

  // --- pairing -------------------------------------------------------------

  #onPairBegin(conn: Conn): void {
    if (conn.role !== 'agent') return this.#fail(conn, 'role', 'only agents may begin pairing');
    this.#sweepPending();
    const code = pairingCode();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    this.#pending.set(code, { code, agentPubkey: conn.pubkey!, conn, expiresAt });
    this.#send(conn, { t: 'pair.pending', code, expiresAt });
  }

  #onPairClaim(conn: Conn, code: string): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only wallets may claim codes');
    this.#sweepPending();
    const pending = this.#pending.get(code);
    if (!pending) return this.#fail(conn, 'pair_unknown', 'unknown or expired pairing code', code);
    this.#send(conn, {
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
    this.#pending.delete(code);
    pending.conn.bound = true;

    this.#send(pending.conn, { t: 'pair.bound', cert });
    this.#send(conn, { t: 'pair.bound', cert });
    this.#log(`paired ${cert.agent.slice(0, 8)} -> user ${cert.user.slice(0, 8)}`);
  }

  #sweepPending(): void {
    const now = Date.now();
    for (const [code, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(code);
    }
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
        this.#send(conn, { t: 'agents.presence', agent, online });
      }
    }
  }

  // --- session routing -----------------------------------------------------

  #route(conn: Conn, frame: Extract<Frame, { s: string }>): void {
    if (frame.t === 'session.open') return this.#openSession(conn, frame);

    const session = this.#sessions.get(frame.s);
    if (!session) return this.#fail(conn, 'no_session', 'unknown session', frame.s);
    if (session.client !== conn && session.agent !== conn) {
      return this.#fail(conn, 'forbidden', 'not a participant in this session', frame.s);
    }
    if (!mayOriginate(conn.role!, frame.t)) {
      return this.#fail(conn, 'forbidden', `a ${conn.role} may not send ${frame.t}`, frame.s);
    }

    const other = session.client === conn ? session.agent : session.client;
    this.#send(other, frame);

    if (frame.t === 'session.close') {
      session.client.sessions.delete(session.id);
      session.agent.sessions.delete(session.id);
      this.#sessions.delete(session.id);
    }
  }

  #openSession(conn: Conn, frame: Extract<Frame, { t: 'session.open' }>): void {
    if (conn.role !== 'client') return this.#fail(conn, 'role', 'only clients open sessions', frame.s);

    const cert = this.certs.get(frame.agent);
    if (!cert || cert.user !== conn.pubkey) {
      return this.#send(conn, { t: 'session.denied', s: frame.s, reason: 'not_your_agent' });
    }
    const agentConn = this.#agents.get(frame.agent);
    if (!agentConn) {
      return this.#send(conn, { t: 'session.denied', s: frame.s, reason: 'agent_offline' });
    }
    if (this.#sessions.has(frame.s)) {
      return this.#send(conn, { t: 'session.denied', s: frame.s, reason: 'duplicate_session' });
    }
    if (frame.grant.expiresAt <= Date.now()) {
      return this.#send(conn, { t: 'session.denied', s: frame.s, reason: 'grant_expired' });
    }

    const session: Session = { id: frame.s, client: conn, agent: agentConn };
    this.#sessions.set(frame.s, session);
    conn.sessions.add(frame.s);
    agentConn.sessions.add(frame.s);

    // The relay stamps the client key so the agent never has to trust a
    // self-reported identity.
    this.#send(agentConn, { ...frame, client: conn.pubkey! });
    this.#log(`session ${frame.s} ${conn.pubkey!.slice(0, 8)} -> ${frame.agent.slice(0, 8)} (${frame.surface.name})`);
  }
}

export function newSessionId(): string {
  return randomId('sess_');
}
