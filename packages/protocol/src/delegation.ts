/**
 * Is this SessionDelegation an authority, and for what?
 *
 * ONE judge, called by everyone who judges. The rule used to exist as three
 * copies that had already drifted: the relay checked five clauses, the daemon
 * checked seven in a different order with a different failure vocabulary (one
 * of them dead — `typeof delegation.origin !== 'string'`, unreachable since
 * `origin` became a required `display` field), and the page checked a
 * hand-rolled `/^[0-9a-f]{128}$/` against the signature because it could not
 * reach the schema. Nobody compared `issuedAt` to a clock at all, which is the
 * clause this module adds (see `not_yet_valid` below).
 *
 * Two properties this file is built around:
 *
 * 1. **A judge that cannot perform a clause says so in the context**, rather
 *    than quietly omitting it from a conjunction. The relay cannot
 *    authenticate a browser origin; the page cannot know the owner key. Both
 *    are parameters, both are documented, and neither is expressible by
 *    accident.
 * 2. **It composes `verifyDelegation`, never re-implements it.** Signature
 *    verification has exactly one implementation (`crypto.ts`), and this
 *    predicate decides only WHEN it is asked.
 *
 * Browser-safe and dependency-free beyond the protocol's own crypto: this
 * ships inside `connect.js`, into other people's pages, like `hashGrant`.
 */

import { hashGrant, verifyDelegation } from './crypto.js';
import { MAX_DELEGATION_CLOCK_SKEW_MS, MAX_DELEGATION_LIFETIME_MS } from './limits.js';
import type { CapabilityGrant, Hex, SessionDelegation } from './messages.js';

/**
 * Why a delegation is not an authority here. A closed set: every member is a
 * clause below, and the value is for the judge's own log — the wire reason
 * stays whatever that judge already sent (`not_your_agent` at the relay,
 * `bad_delegation` at the daemon), because a refusal must not tell a caller
 * which of seven bindings it got wrong.
 */
export const DELEGATION_DENIALS = [
  'sig',
  'delegate',
  'agent',
  'origin',
  'grant',
  'lifetime',
  'expired',
  'not_yet_valid',
] as const;
export type DelegationDenial = (typeof DELEGATION_DENIALS)[number];

/**
 * The page's honest position on the signature clause.
 *
 * A delegation deliberately carries no `user` field: the root key is exactly
 * what a page must never learn (invariant 7, and e2e asserts the approval
 * payload does not contain it). So `site/src/connect.ts` can check every
 * binding except the one that needs the owner key, and it presents the
 * delegation to two judges that can.
 *
 * This is a REQUIRED field holding an explicit value rather than an optional
 * one, because the two absences are not the same thing: "I cannot verify a
 * signature" is a stated position, while "I have no owner key to verify
 * against" — an unbound daemon — is a refusal. Making the first spellable
 * without making the second silent is the whole reason this constant exists.
 *
 * A symbol rather than a sentinel string, because `Hex` IS `string`: a string
 * sentinel would make `Hex | typeof SIGNER_UNKNOWN` collapse back to `string`
 * and the compiler would stop asking the question this constant is here to
 * force.
 */
export const SIGNER_UNKNOWN: unique symbol = Symbol('agentport.signer-unknown');

export interface DelegationContext {
  /**
   * Who must have signed it: the `user` from the agent's own cert, which the
   * judge holds independently. `SIGNER_UNKNOWN` skips the signature clause and
   * is only ever correct for a judge that structurally cannot know the key.
   */
  owner: Hex | typeof SIGNER_UNKNOWN;
  /** The one agent this authority may reach, as this judge knows it. */
  agent: Hex;
  /**
   * The key this judge authenticated as the presenter. `undefined` is admitted
   * and always denies: a judge that authenticated nobody has nobody for the
   * authority to name, and the alternative — a `!` at the call site — turns
   * "nobody" into a silent pass the day that invariant moves.
   */
  delegate: Hex | undefined;
  /**
   * The browser-verified origin this attachment arrived from, when the judge
   * can see one. OMIT IT WHEN IT CANNOT: **this judge cannot see a browser
   * origin** is the relay's real position — it routes an opaque socket and the
   * signed origin merely rides along for the daemon to compare against
   * `session.open`'s surface. Omitting it makes the relay's check weaker on
   * purpose and says so; the daemon always supplies it, so the binding is
   * enforced exactly once by the party that can.
   */
  origin?: string;
  /**
   * The grant presented alongside the delegation. Hashed here rather than
   * taken pre-hashed, so no caller can pass a digest of something other than
   * the grant it is about to honour.
   */
  grant: CapabilityGrant;
  /** This judge's own clock, Unix ms. Never a value from the wire. */
  now: number;
}

/**
 * `undefined` when this delegation authorises this attachment; otherwise the
 * clause that refused it.
 *
 * Clause order is cheapest-first and the signature is last, deliberately: an
 * unauthenticated peer must not be able to spend an Ed25519 verification on a
 * statement that names the wrong agent. Every field compared here is covered
 * by that signature, so an early mismatch is a safe early exit — a forged
 * field can only cause an earlier denial, never an acceptance.
 */
export function delegationAuthorizes(
  delegation: SessionDelegation,
  context: DelegationContext,
): DelegationDenial | undefined {
  if (delegation.delegate !== context.delegate) return 'delegate';
  if (delegation.agent !== context.agent) return 'agent';
  if (context.origin !== undefined && delegation.origin !== context.origin) return 'origin';

  // The lifetime bound is what stops an approval outliving the browser session
  // that made it, and what keeps the daemon's revocation store finite by
  // construction (ADR-022 R3). Every judge applies it; none may assume another
  // did.
  const lifetime = delegation.expiresAt - delegation.issuedAt;
  if (lifetime <= 0 || lifetime > MAX_DELEGATION_LIFETIME_MS) return 'lifetime';
  if (delegation.expiresAt <= context.now) return 'expired';
  // The clause no judge had. `expiresAt > now` and a bounded span say nothing
  // about WHEN the span starts, so a delegation dated forward was well-formed
  // to all three judges — and post-dating is not a curiosity: `isRevoked`
  // refuses only `issuedAt <= tombstone.at`, so a future date walks past every
  // revocation already recorded, and the lifetime bound slides forward with
  // it. See MAX_DELEGATION_CLOCK_SKEW_MS for why the tolerance is what it is.
  //
  // This did not bump PROTOCOL_VERSION, and the distinction is worth stating:
  // the version exists for a rule an older endpoint would SILENTLY OMIT while
  // an upgraded peer believes it is covered. This rule is not that shape —
  // relay and daemon each enforce it for themselves, so an upgraded judge is
  // protected regardless of what the other end runs, and the only deployment
  // that omits it is one where nothing was upgraded at all.
  if (delegation.issuedAt > context.now + MAX_DELEGATION_CLOCK_SKEW_MS) return 'not_yet_valid';

  // Structural at the relay, authoritative at the daemon, and the same
  // comparison at both: an approval must not be replayable under a grant the
  // user never saw.
  if (delegation.grantHash !== hashGrant(context.grant)) return 'grant';

  if (context.owner !== SIGNER_UNKNOWN && !verifyDelegation(context.owner, delegation)) return 'sig';
  return undefined;
}
