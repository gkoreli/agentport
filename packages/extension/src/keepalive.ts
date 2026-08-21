/**
 * Keeping the MV3 worker awake exactly as long as there is something to keep
 * awake — and, just as much, letting it sleep when there is not.
 *
 * Chrome stops an idle MV3 worker after 30s. Socket traffic resets that timer
 * (Chrome 116+), but a session that is merely *open* and quiet would not, so
 * something has to touch an extension API while any session exists; that keeps
 * alive the worker, its socket, and the wallet's own redial timers with it.
 *
 * Waking the worker is all this can do. An eviction takes the session table
 * with it — it is in memory deliberately, because the transcript is the user's
 * — so a woken worker has no attachment left to redial FOR. Recovering from an
 * eviction is `resumeFromStore` in `sw.ts`, driven by the next document that
 * connects carrying a matching resume record.
 *
 * WHICH IS WHY THE GATE IS THE WHOLE POINT. A periodic alarm that fires
 * whether or not anything is attached wakes the worker every minute for the
 * life of the install to do nothing — and `chrome.alarms` OUTLIVES the worker,
 * so an alarm armed by one generation goes on waking every later one until
 * something clears it. Nothing ever did. This object is the something: it holds
 * the belief about whether an alarm is armed and reconciles it against the live
 * session count, so the alarm exists during a session and at no other time.
 *
 * It takes its host for the same reason `widget.ts` and `consent-windows.ts`
 * do. The chrome-shaped half is three calls — touch, arm, clear — so injecting
 * them lets `packages/extension/check.ts` drive the transitions that matter,
 * including the one that costs a user their session if it is wrong: an alarm
 * cleared when the last session ends and never re-armed when the next one
 * starts is a resume that dies with the worker.
 */

import { createLogger, type Logger } from '@agentport/protocol';

export interface KeepAliveHost {
  /** The wake-up itself: touch an extension API to reset Chrome's idle timer. */
  touch(): void;
  /** Arm the periodic alarm that wakes an evicted-but-needed worker. */
  arm(): void;
  clear(): void;
}

export interface KeepAliveOptions {
  host: KeepAliveHost;
  /** How many attachments are live right now. Owned by the session registry. */
  live(): number;
  log?: Logger;
}

export class KeepAlive {
  readonly #host: KeepAliveHost;
  readonly #live: () => number;
  readonly #log: Logger;
  /**
   * Whether an alarm is believed to be armed, and it starts TRUE on purpose.
   *
   * `chrome.alarms` is persistent: a fresh worker may inherit an alarm a
   * previous generation armed while a session was live, and that alarm is
   * invisible from here. Starting pessimistic means the first reconcile with no
   * live session clears the inherited one, which is the only moment anything
   * ever could.
   */
  #armed = true;

  constructor(options: KeepAliveOptions) {
    this.#host = options.host;
    this.#live = options.live;
    this.#log = options.log ?? createLogger('extension.keepalive');
  }

  /** Reconcile the alarm with the session table. Call after every change to it. */
  sync(): void {
    const needed = this.#live() > 0;
    if (needed === this.#armed) return;
    this.#armed = needed;
    if (needed) this.#host.arm();
    else this.#host.clear();
    this.#log.debug(needed ? 'keep-alive armed for a live session' : 'keep-alive cleared; nothing is attached', {
      data: { live: this.#live() },
    });
  }

  /**
   * A periodic signal arrived — the alarm fired, or the in-worker interval
   * ticked. Touch only if there is still something to keep awake; otherwise
   * this is an alarm nobody needs, so stop being woken by it.
   */
  wake(): void {
    if (this.#live() > 0) {
      this.#host.touch();
      return;
    }
    this.sync();
  }
}
