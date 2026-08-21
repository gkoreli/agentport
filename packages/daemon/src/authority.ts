/**
 * "May this attachment do X, right now?" — asked once, in one place.
 *
 * That question used to have three unrelated spellings inside the daemon: a
 * `#authorityError` that compared two deadlines, a `session.tools.find(...)`
 * for membership, and a revocation check that lived at open and resume and
 * nowhere else. Three spellings is three chances for one of them to be missing
 * a clause, and one of them was: revocation never reached live traffic, and it
 * never reached a direct-key attachment at all (ADR-022 addendum).
 *
 * So the boundary is a value object built ONCE when the attachment opens, from
 * everything that bounds it, and every checkpoint asks it rather than
 * re-deriving the rule. It is deliberately I/O-free apart from the revocation
 * store it was handed: no sockets, no clock of its own — the caller passes the
 * daemon's `now`, which is the same test seam `DaemonOptions.now` already is.
 */

import {
  SESSION_DENIAL_REASONS,
  type CapabilityGrant,
  type SessionDelegation,
  type SessionDenialReason,
  type ToolDefinition,
} from '@agentport/protocol';
import { isRevoked, type Revocation, type RevocationStore } from './revocations.js';

/**
 * Why an attachment may not act. Type-linked to the wire's own registry, so a
 * reason that stops being a `session.denied` word is a build error here rather
 * than a string the resume path sends and no client understands.
 */
export type AuthorityDenialReason = Extract<
  SessionDenialReason,
  'grant_expired' | 'authorization_expired' | 'revoked'
>;

/**
 * A refusal that is both throwable and classifiable.
 *
 * An `Error`, because three of the four checkpoints reject a promise with it
 * and one puts `.message` on the wire; a `reason` beside it, because the
 * resume path has to name the refusal in a `session.denied` frame and the
 * sweep has to pick a close reason. One object rather than an error and a
 * parallel predicate: the two could not then disagree about what happened.
 */
export class AuthorityDenied extends Error {
  readonly reason: AuthorityDenialReason;

  constructor(reason: AuthorityDenialReason, message: string) {
    super(message);
    this.name = 'AuthorityDenied';
    this.reason = reason;
  }
}

export interface AttachmentAuthorityInput {
  grant: CapabilityGrant;
  /** The hosted wallet's authority for this page identity, when there is one. */
  delegation?: SessionDelegation | undefined;
  /** The surface's origin — the address a tombstone is written against. */
  origin: string;
  /** Unix ms at which THIS attachment's own authority began. */
  openedAt: number;
  revocations: RevocationStore;
}

export class AttachmentAuthority {
  /**
   * The attachment's live lifetime: `min(grant, delegation)`, computed once
   * (invariant 2). Staying connected must not turn a short delegation into a
   * longer grant, and one number is what makes that impossible to spell two
   * ways.
   */
  readonly expiresAt: number;

  readonly #grant: CapabilityGrant;
  readonly #delegation: SessionDelegation | undefined;
  readonly #revocations: RevocationStore;
  /**
   * What a tombstone is judged against: the origin this attachment belongs to,
   * and the instant its authority began.
   *
   * For a DELEGATED attachment that is the delegation's own `{origin,
   * issuedAt}` — ADR-022 R1/R2 exactly as shipped. For a DIRECT-KEY attachment
   * there is no delegation to address, so the authority IS the session: the
   * surface's origin, beginning when the user opened it. Without that second
   * row the extension tier — which holds the user key and therefore carries no
   * delegation — sat outside every revocation check in the daemon, and
   * `agentport revoke` wrote a tombstone, logged a count, and left the
   * attachment running and reopenable.
   */
  readonly #instant: { origin: string; issuedAt: number };
  /**
   * The last look at the tombstones. Kept only so `lateError` has an answer
   * without taking another one; every path that GRANTS authority looks again.
   */
  #looked: { revoked: boolean } | undefined;

  constructor(input: AttachmentAuthorityInput) {
    this.#grant = input.grant;
    this.#delegation = input.delegation;
    this.#revocations = input.revocations;
    this.expiresAt = Math.min(input.grant.expiresAt, input.delegation?.expiresAt ?? Infinity);
    this.#instant = input.delegation
      ? { origin: input.delegation.origin, issuedAt: input.delegation.issuedAt }
      : { origin: input.origin, issuedAt: input.openedAt };
  }

  /**
   * The tool this attachment may call under that name, or `undefined`.
   *
   * Returns the DEFINITION rather than a boolean because every caller that may
   * proceed needs it next — `isGated` reads the tool's own `requiresApproval` —
   * and a second lookup would be the same membership question asked twice,
   * which is how it came to be spelled separately from the rest of this
   * boundary in the first place.
   */
  allows(name: string): ToolDefinition | undefined {
    return this.#grant.tools.find((tool) => tool.name === name);
  }

  /**
   * Why new work may not START here — an open, a resume, a prompt, a tool
   * dispatch — or `undefined` when it may.
   *
   * Takes a FRESH look at the tombstones. `agentport revoke` writes the file
   * and never talks to the daemon, so anything that grants authority has to
   * read it rather than trust a cached verdict: the whole point of ADR-022 R4
   * is that a tombstone alone makes a session unresumable, before any teardown
   * has happened.
   *
   * This is consulted on LIVE traffic, not just open and resume. Staying
   * connected must not turn a short delegation into a longer grant, and a
   * prompt admitted after the user cut the origin off is work they withdrew
   * their consent for.
   */
  error(now: number): AuthorityDenied | undefined {
    return this.#judge(now, this.#revoked());
  }

  /**
   * Why work already ADMITTED may not complete — a tool result arriving from
   * the page after the boundary moved.
   *
   * The same clauses, and deliberately not a second look at the tombstones.
   * The authority question for this call was already asked, with a fresh look,
   * when the call was dispatched; a result is the answer to it, not a new
   * request. Paying for another synchronous read+parse of the tombstone file
   * on the RECEIVE path would buy nothing a revocation does not already do
   * better — the sweep closes a revoked session, and closing rejects every
   * in-flight call it is holding.
   */
  lateError(now: number): AuthorityDenied | undefined {
    return this.#judge(now, this.#looked?.revoked ?? false);
  }

  /**
   * The daemon's sweep hands over the tombstones it has already read, so one
   * store read serves every live attachment. Returns whether this one is now
   * refused by them, which is what the sweep closes on — and leaves the answer
   * behind as the last look, which is what `lateError` reads.
   */
  observe(revocations: readonly Revocation[]): boolean {
    const revoked = isRevoked(revocations, this.#instant);
    this.#looked = { revoked };
    return revoked;
  }

  #revoked(): boolean {
    return this.observe(this.#revocations.list());
  }

  #judge(now: number, revoked: boolean): AuthorityDenied | undefined {
    // The precomputed minimum is the fast path: one comparison answers the
    // ordinary case, and the specific clause is only worth deriving once
    // something has actually failed.
    if (now < this.expiresAt) {
      return revoked ? new AuthorityDenied(SESSION_DENIAL_REASONS.revoked, 'attachment authority was revoked') : undefined;
    }
    if (this.#grant.expiresAt <= now) return new AuthorityDenied(SESSION_DENIAL_REASONS.grant_expired, 'capability grant expired');
    if (this.#delegation && this.#delegation.expiresAt <= now) {
      return new AuthorityDenied(SESSION_DENIAL_REASONS.authorization_expired, 'delegation authorization expired');
    }
    // Unreachable while `expiresAt` is the minimum of exactly those two, and
    // stated rather than assumed: a third bound added above without a clause
    // here would otherwise refuse with a message naming neither.
    return new AuthorityDenied(SESSION_DENIAL_REASONS.grant_expired, 'capability grant expired');
  }
}
