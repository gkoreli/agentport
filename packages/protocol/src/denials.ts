/**
 * Why a session was refused, and which refusals a resumable client must stop
 * retrying.
 *
 * Invariant 9 — a page reload re-attaches the SAME bounded identity, and
 * withdrawn authority is never retried — rested on two hand-copied string
 * lists. `site/src/connect.ts` and `packages/extension/src/sw.ts` each spelled
 * out four reasons to decide whether a durable resume record dies or lives to
 * try again, while the reasons themselves were free text at two producers that
 * had never heard of either list. A new terminal reason on the daemon would
 * have been classified transient by both consumers, which does not fail — it
 * retries withdrawn authority, forever, quietly.
 *
 * So the reasons are a registry both producers emit FROM, and the terminality
 * question is answered once, here, beside them.
 *
 * Since v7 the wire schema enforces this registry too: `SessionDenied.reason`
 * is an enum over exactly this union, so a producer inventing a reason is a
 * malformed frame at the sender's own decoder, not a string a consumer
 * guesses about. `isTerminalResumeDenial` still takes a `string` on purpose —
 * its callers read the field from a frame that may predate this build inside
 * one deploy window, and an unrecognised reason stays transient, which is the
 * fail-safe answer (retry a live session) rather than the fail-silent one
 * (discard a record that could still resume).
 */

/**
 * Every reason a `session.denied` frame may carry, from both producers.
 *
 * `packages/relay/src/core.ts` emits: `agent_offline`, `not_your_agent`,
 * `duplicate_session`, `grant_expired`. `packages/daemon/src/daemon.ts` emits
 * the rest, plus its own `not_your_agent` and `grant_expired`.
 */
export const SESSION_DENIAL_REASONS = {
  /** Relay: nothing is connected under that agent key right now. */
  agent_offline: 'agent_offline',
  /** Daemon: another live socket already holds this session. TRANSIENT — the
   *  old tab's close has not reached the relay yet, and treating this as death
   *  is how a one-second race became a permanently lost session. */
  already_attached: 'already_attached',
  /** Daemon: the delegation behind this attachment expired, or was revoked
   *  after the session opened. */
  authorization_expired: 'authorization_expired',
  /** Daemon: the delegation chain does not hold — see `delegation.ts` for the
   *  seven clauses this one word covers, none of which it discloses. */
  bad_delegation: 'bad_delegation',
  /** Both: the Ed25519 proof over the ephemeral sealing key did not verify. */
  bad_epk_proof: 'bad_epk_proof',
  /** Daemon: no live owner approval matches this connect attempt. */
  connect_not_approved: 'connect_not_approved',
  /** Relay: that session id is already routed. */
  duplicate_session: 'duplicate_session',
  /** Both: the capability grant's own deadline has passed. */
  grant_expired: 'grant_expired',
  /** Daemon: no such session to resume, or the resumer did not prove the
   *  identity captured when it opened. */
  not_resumable: 'not_resumable',
  /** Both: the opener neither owns this agent nor holds authority over it. */
  not_your_agent: 'not_your_agent',
  /** Daemon: the user withdrew this origin's authority (ADR-022). */
  revoked: 'revoked',
  /** Daemon: the runtime could not be started for this session. */
  runtime_failed: 'runtime_failed',
  /** Daemon: the opener sent no sealing key, and plaintext is not a session. */
  sealing_required: 'sealing_required',
} as const;

export type SessionDenialReason = (typeof SESSION_DENIAL_REASONS)[keyof typeof SESSION_DENIAL_REASONS];

/**
 * The refusals that PROVE a stored resume record is dead.
 *
 * Type-linked to the registry, so a member named here that is not a real
 * reason is a build error. Deliberately partial in the other direction: a
 * reason missing from this set is treated as transient, which keeps a record
 * that might still resume rather than discarding one that could.
 */
const TERMINAL_RESUME_DENIAL_MEMBERS = {
  not_resumable: true,
  grant_expired: true,
  authorization_expired: true,
  revoked: true,
} as const satisfies Partial<Record<SessionDenialReason, true>>;

const TERMINAL_RESUME_DENIALS = new Set<string>(Object.keys(TERMINAL_RESUME_DENIAL_MEMBERS));

/**
 * Does this denial mean the resume record should be deleted rather than kept
 * for the next load? Takes a `string` because the wire carries one; anything
 * unrecognised is transient.
 */
export function isTerminalResumeDenial(reason: string): boolean {
  return TERMINAL_RESUME_DENIALS.has(reason);
}
