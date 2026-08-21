/**
 * The daemon's socket to the relay, and nothing else.
 *
 * A passenger lifted out of `daemon.ts`: dialing, the greeting, the ws
 * ping/pong liveness probe, the handshake deadline, backoff and redial, and the
 * decode-and-drop boundary in front of the owner. It emits decoded frames and a
 * `down` event; it knows nothing about sessions. No attachment, grant,
 * transcript or consent surface is reachable from this file, which is the point
 * of it being one — the session aggregate stays whole in `daemon.ts`, and this
 * is a thing that shared nothing with it.
 *
 * **The revocation sweep is deliberately NOT here.** One interval used to ping
 * the relay and sweep stale connect offers, detached sessions and revocation
 * tombstones, with a `sweepsPerPing` divider so that shortening the sweep for a
 * test could not shorten the pong deadline with it. That sharing is a cadence,
 * not a responsibility: the sweep is session logic and stayed with the daemon,
 * which subscribes `tick`. The tick fires at the OWNER's cadence and the ping
 * rides on top of it at its own — including firing only while a socket exists,
 * so a daemon in backoff sweeps nothing, exactly as the single interval did.
 *
 * **What this link does not judge.** `ready` is a protocol frame, so the owner
 * — not this file — decides that a handshake succeeded and says so with
 * `handshakeSucceeded()`. A link that read frames to answer its own questions
 * would be a second, quieter copy of the daemon's router.
 *
 * **Non-goal: unifying this with the wallet's dial loop**
 * (`packages/client/src/wallet.ts`). They rhyme — dial, back off, redial — and
 * they diverge at the only interesting moment: the wallet re-resumes every live
 * session over the new socket and judges per-session denials, while this end
 * holds its sessions open across the gap and waits to be resumed. Merging them
 * would be a cross-package abstraction with one real behaviour on each side of
 * it, and this side does not need the other's.
 */

import { WebSocket } from 'ws';
import {
  Emitter,
  MAX_FRAME_CHARS,
  PROTOCOL_VERSION,
  WireViolation,
  decodeFrame,
  encodeFrame,
  type Frame,
  type Logger,
} from '@agentport/protocol';

/**
 * How often the daemon pings the relay to prove the pipe is still there.
 *
 * Kept separate from the owner's tick cadence rather than riding on it: that
 * cadence is a test seam, and a 200 ms sweep must not become a 200 ms pong
 * deadline, which any momentarily busy event loop would miss and answer by
 * terminating a perfectly healthy socket.
 */
const PING_INTERVAL_MS = 30_000;

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

/** First redial delay, and the ceiling the doubling stops at. */
const REDIAL_BASE_MS = 1000;
const REDIAL_MAX_MS = 30_000;

export interface RelayLinkOptions {
  /** The relay to dial, e.g. `wss://host/relay`. */
  url: string;
  /**
   * The owner's own logger, handed down rather than created here, so the
   * transport's lines carry the component an operator already greps for.
   */
  log: Logger;
  /** Test seam, forwarded from `DaemonOptions.handshakeTimeoutMs`. */
  handshakeTimeoutMs?: number | undefined;
  /**
   * How often `tick` fires while a socket exists. The owner's housekeeping
   * cadence, which the ping divides down to its own; see the module doc.
   */
  tickIntervalMs: number;
}

export type RelayLinkEvents = {
  /** A frame that decoded cleanly. Anything else was dropped and logged. */
  frame: Frame;
  /** The housekeeping beat, at `tickIntervalMs`, only while a socket exists. */
  tick: undefined;
  /** The socket went away. A redial is already scheduled unless stopped. */
  down: undefined;
  /**
   * The connection cannot be established, and a pending `start()` should say
   * so. Emitted for a socket-level failure and for whatever the owner reports
   * through `fail()`; settle-once is the subscriber's business.
   */
  failed: Error;
};

export class RelayLink extends Emitter<RelayLinkEvents> {
  readonly #options: RelayLinkOptions;
  readonly #log: Logger;
  #socket: WebSocket | undefined;
  #stopped = false;
  #retryMs = REDIAL_BASE_MS;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #readyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: RelayLinkOptions) {
    super();
    this.#options = options;
    this.#log = options.log;
  }

  /**
   * Dial, and STAY dialed: a relay redeploy (Durable Objects sever every socket
   * when the Worker updates), an idle eviction, or any network blip is survived
   * by redialing with backoff. Without this the daemon is a zombie after the
   * first deploy — running, but reachable by nobody.
   */
  start(): void {
    // Armed here rather than in `#dial`, because `#dial` also runs for every
    // later redial and those are the close handler's business, not the
    // caller's — `start()` has long since settled by then.
    const handshakeMs = this.#options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
    this.#readyTimer = setTimeout(() => {
      this.fail(new Error(`the relay did not finish the handshake within ${handshakeMs}ms`));
    }, handshakeMs);
    this.#dial();
  }

  /**
   * The owner judged the handshake complete: disarm the deadline and forget the
   * accumulated backoff, so the next blip retries promptly.
   */
  handshakeSucceeded(): void {
    this.#disarm();
    this.#retryMs = REDIAL_BASE_MS;
  }

  /**
   * This connection cannot come up, for a reason the owner may know better than
   * the socket does — a relay that refused the identify, say. Disarms the
   * deadline and reports it once through `failed`; a subscriber whose settle is
   * settle-once turns a later arrival into a no-op, which is what makes this
   * harmless after a successful handshake.
   */
  fail(err: Error): void {
    this.#disarm();
    this.emit('failed', err);
  }

  /** Frames leave only over an OPEN socket; there is nowhere else to put them. */
  send(frame: Frame): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(encodeFrame(frame));
  }

  /**
   * Close the current socket WITHOUT giving up: the ordinary redial path takes
   * over, which is how `unpair()` re-identifies without a cert.
   */
  close(): void {
    this.#socket?.close();
  }

  /**
   * Stop redialing and drop every timer — but leave the socket open, because
   * the owner still has goodbyes to send over it (`session.close` per live
   * attachment) before calling `close()`. Two verbs for what looks like one
   * step, because collapsing them would either drop those frames or leave a
   * close during teardown scheduling a fresh dial.
   */
  stop(): void {
    this.#stopped = true;
    clearInterval(this.#heartbeat);
    this.#disarm();
  }

  #disarm(): void {
    clearTimeout(this.#readyTimer);
    this.#readyTimer = undefined;
  }

  #dial(): void {
    if (this.#stopped) return;
    // maxPayload caps what a broken or hostile relay can buffer into daemon
    // memory before decodeFrame's own char bound runs (ws client default is
    // 100 MiB) — the same ceiling the relay itself enforces.
    const socket = new WebSocket(this.#options.url, { maxPayload: MAX_FRAME_CHARS });
    this.#socket = socket;

    socket.on('open', () => {
      // The greeting belongs to the link: it is what makes this socket a relay
      // connection rather than a socket. Everything after it is the owner's.
      this.send({ t: 'hello', v: PROTOCOL_VERSION, role: 'agent' });
    });
    socket.on('message', (data, isBinary) => {
      // Text frames only — mirrors both relay hosts; binary has no meaning
      // in this protocol and stringifying it would invent one.
      if (isBinary) {
        this.#log.warn('dropped binary relay message', { data: { relayUrl: this.#options.url } });
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
            data: { code: err.code, path: err.path, relayUrl: this.#options.url },
          });
        } else {
          this.#log.warn('dropped undecodable frame', { err, data: { relayUrl: this.#options.url } });
        }
        return;
      }
      this.emit('frame', frame);
    });

    // Half-open sockets (NAT timeouts, silent relay death) look connected
    // forever without this. ws answers our ping with a pong; no pong within
    // the next beat means the pipe is gone.
    let alive = true;
    socket.on('pong', () => (alive = true));
    clearInterval(this.#heartbeat);
    const tickMs = this.#options.tickIntervalMs;
    // The ping keeps its own cadence ON TOP of the owner's tick, so shortening
    // that tick for a test cannot shorten the pong deadline with it.
    const ticksPerPing = Math.max(1, Math.round(PING_INTERVAL_MS / tickMs));
    let ticksSincePing = 0;
    this.#heartbeat = setInterval(() => {
      this.#beat();
      if (socket.readyState !== WebSocket.OPEN) return;
      if (++ticksSincePing < ticksPerPing) return;
      ticksSincePing = 0;
      if (!alive) {
        this.#log.warn('heartbeat lost; terminating socket to force a redial');
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, tickMs);

    socket.on('close', () => {
      clearInterval(this.#heartbeat);
      this.emit('down', undefined);
      if (this.#stopped) return;
      const delay = this.#retryMs;
      this.#retryMs = Math.min(this.#retryMs * 2, REDIAL_MAX_MS);
      this.#log.warn('relay connection lost; scheduling redial', {
        data: { delayMs: delay, relayUrl: this.#options.url },
      });
      setTimeout(() => this.#dial(), delay);
    });
    socket.on('error', (err) => {
      this.#log.error('relay websocket failed', { err, data: { relayUrl: this.#options.url } });
      // Before the first ready this is fatal to the caller; afterwards the
      // close handler owns recovery and the owner's settle-once ignores it.
      this.fail(err);
    });
  }

  /**
   * The housekeeping beat, dispatched where a subscriber's throw cannot take
   * the ping with it. This interval is what proves the socket is still alive,
   * so a bug in the owner's sweep must not turn into a silently half-open
   * connection that nothing ever redials.
   */
  #beat(): void {
    try {
      this.emit('tick', undefined);
    } catch (err) {
      this.#log.error('a relay link tick subscriber failed', { err });
    }
  }
}
