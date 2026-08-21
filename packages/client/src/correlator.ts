import { Deferred, type Frame, type FrameType, type Logger } from '@agentport/protocol';

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

/** A registered wait: the answer, and the means to withdraw the waiter. */
export interface PendingReply<T extends FrameType> {
  promise: Promise<Extract<Frame, { t: T }>>;
  cancel: () => void;
}

/**
 * Single-shot request/response correlation by frame type.
 *
 * Lifted out of `AgentWallet`, which is where it was written and where it did
 * not belong: nothing here knows about wallets, sockets, sessions or keys —
 * frames go in, waiting callers come out. It was extracted because the two
 * properties recorded in the comments below had both already been bugs, and
 * neither could be exercised without standing up a wallet, a socket and a
 * relay, so neither had ever been asserted directly. `scripts/client-check.ts`
 * asserts them against this class alone.
 *
 * Its whole reason to exist is that a caller must never be left waiting on an
 * answer that already came, or on one that can never come.
 */
export class FrameCorrelator {
  readonly #waiters = new Map<string, Deferred<Frame>[]>();
  readonly #log: Logger;

  constructor(log: Logger) {
    this.#log = log;
  }

  /**
   * Register a wait, cancellably: a failed attempt must withdraw its waiter
   * or the leftover deferred swallows the reply meant for the retry.
   */
  register<T extends FrameType>(...types: T[]): PendingReply<T> {
    const deferred = new Deferred<Frame>();
    for (const type of types) {
      const list = this.#waiters.get(type) ?? [];
      list.push(deferred);
      this.#waiters.set(type, list);
    }
    const cancel = () => this.#withdraw(deferred);
    // `resolve` only settles a waiter with a decodeFrame-validated frame whose
    // `t` matched the type it was filed under, so this narrowing holds by
    // construction — it is what lets replies flow typed to every call site.
    return { promise: deferred.promise as Promise<Extract<Frame, { t: T }>>, cancel };
  }

  /**
   * Wait for the next frame of any of these types. Always withdraws BOTH queue
   * entries once settled: a deferred registered under two types and answered
   * by one used to leave a stale twin that silently consumed the next frame of
   * the other type — an off-by-one that starved every waiter behind it.
   * Correlation waiters must never outlive their answer.
   */
  async expect<T extends FrameType>(...types: T[]): Promise<Extract<Frame, { t: T }>> {
    const pending = this.register(...types);
    try {
      return await pending.promise;
    } finally {
      pending.cancel();
    }
  }

  /**
   * `expect` with a deadline, for round-trips that involve no human: relay and
   * daemon answer at machine speed or something is wrong. The waiter is
   * withdrawn on timeout so it cannot swallow a late reply meant for a retry.
   */
  async expectTimed<T extends FrameType>(
    label: string,
    timeoutMs: number,
    ...types: T[]
  ): Promise<Extract<Frame, { t: T }>> {
    const pending = this.register(...types);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} handshake timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      return await Promise.race([pending.promise, deadline]);
    } finally {
      clearTimeout(timer);
      pending.cancel();
    }
  }

  /** Settle a waiter with this frame. False means nobody was waiting for it. */
  resolve(frame: Frame): boolean {
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

  /**
   * Nothing more will arrive: fail everything still waiting.
   *
   * Called on an intentional teardown, where the answer a caller is waiting
   * for provably cannot come — the socket is gone and no redial will follow.
   * Rejecting cannot lose an answer that could still have arrived, and the
   * alternative is a promise that never settles, which is this file's whole
   * subject: a refusal the caller never hears is indistinguishable from a
   * hang.
   *
   * A deferred filed under two types must be rejected ONCE and removed from
   * both queues — the stale-twin rule again, at teardown.
   *
   * This is the one behavioural addition the extraction brought:
   * `AgentWallet#close()` used to leave these pending forever. It is safe
   * because every deferred in here was created by a call site that awaits or
   * races its promise in the same expression, so the rejection always has a
   * handler — nothing here can become an unhandled rejection.
   */
  close(reason: string): void {
    const pending = new Set<Deferred<Frame>>();
    for (const [, queue] of this.#waiters) for (const deferred of queue) pending.add(deferred);
    this.#waiters.clear();
    if (pending.size === 0) return;
    this.#log.warn('discarding requests that can no longer be answered', {
      data: { pending: pending.size, reason },
    });
    for (const deferred of pending) deferred.reject(new Error(`request abandoned: ${reason}`));
  }

  #withdraw(deferred: Deferred<Frame>): void {
    for (const [, list] of this.#waiters) {
      const index = list.indexOf(deferred);
      if (index >= 0) list.splice(index, 1);
    }
  }
}
