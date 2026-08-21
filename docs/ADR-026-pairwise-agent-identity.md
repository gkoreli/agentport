# ADR-026: Pairwise agent identity — one agent, a different name at every door

- **Status:** proposed. Nothing here is implemented; this ADR exists because
  the change MUST precede Chrome Web Store distribution (phase 5), and an
  identifier scheme cannot be changed after sites depend on it.
- **Date:** 2026-08-21
- **Owners:** AgentPort maintainers
- **Depends on:** ADR-003 (end-to-end sealing, TOFU + fingerprint words),
  ADR-009 (extension custody; names the pairwise requirement as blocking),
  ADR-016 (the relay stores nothing), ADR-018 (security architecture),
  ADR-022 (origin-keyed revocation), the v7 per-tier disclosure precedent
  (`packages/daemon/src/daemon.ts#onSessionOpen`, `responseRuntime`)
- **Blocks:** extension distribution (the store listing); protocol v8

## Context: the supercookie

Every site a user attaches to learns a stable identifier for the agent. Two
edges leak it to page world:

1. `session.opened` / `session.resumed` carry `agent` — and the relay stamps
   it from the authenticated socket (`packages/relay/src/core.ts#openSession`),
   so it is always the agent's ROOT device key.
2. In the hosted-wallet tier the page holds the `SessionDelegation`, whose
   `agent` field names the same root key
   (`packages/protocol/src/messages.ts#SessionDelegation`).

Any two sites can compare notes and learn they were visited by the same
agent — therefore, with overwhelming probability, the same person. That is
not on the north star's list of what a site learns, and it quietly undermines
the item that IS on the list: "what else the agent can reach" becomes
inferable across the web the moment two origins can join their logs. ADR-009
named pairwise per-origin identity a blocking requirement for exactly this
reason. The clock on it is distribution: after a store listing, sites begin
to persist whatever identifier they see, and a later change breaks them.

## Decision (proposed)

**A page-facing surface learns a per-origin agent identity, derived from the
root key and the origin, and nothing page-facing ever carries the root.**

### D1. Derivation

The daemon derives a per-origin Ed25519 keypair deterministically:

```
seed_o  = HKDF-SHA256(ikm = root seed, salt = "agentport/pairwise/v1", info = origin)
(A_o, a_o) = ed25519-keypair(seed_o)
```

Deterministic, so nothing is stored and revocation/rotation follow the root
key automatically. The derivation lives in `@agentport/protocol` beside the
existing crypto (pure, browser-safe, directly checkable in the wire harness).
Property to assert: distinct origins yield unlinkable keys; the same origin
yields the same key across restarts.

### D2. Which parties see which identity

| party | identity seen | why |
|---|---|---|
| relay | root | routing and ownership (`AgentCert` binds user→root; invariant 6 is checked against it) — unchanged |
| owner-key clients (extension SW, hosted wallet origin, inkwell) | root | they hold the cert; the picker and pairing are trust decisions about the real agent — unchanged |
| page world (drop-in connect, delegated attachments, widget-visible info) | A_o only | the page's anchor was never the key; it is TOFU plus the fingerprint words (ADR-003), which derive from the ephemeral X25519 keys and are untouched |

This is the same shape v7 shipped for `runtime`: disclosure decided per tier
at the answer site, not by the field's existence.

### D3. What must change, per mechanism

- **EPK proofs.** For page-tier attachments the daemon signs the ephemeral-key
  transcript with `a_o`, and the page verifies against `A_o`. The transcript
  already names the agent inside the signed binding
  (`packages/protocol/src/seal.ts#openProofBinding`,
  `#resumeProofBinding`, `#answerProofBinding`), so the pairwise key is
  authenticated by the proof itself, not asserted beside it. Scope- and
  version-binding (`packages/protocol/src/seal.ts#epkProofMessage`) are
  unchanged.
- **The relay's stamp becomes tier-shaped.** Today the stamp exists so a
  party who CAN check certs cannot be lied to about which agent answered.
  A page cannot check a cert at all — its verification never ran through the
  stamp. So: toward an opener that authenticated with an owner-cert-bound
  identity, the relay stamps root exactly as today; toward any other opener
  it forwards the daemon-authored `agent` field (which carries A_o) without
  substitution. The stamp keeps protecting the parties it ever protected.
- **Delegations name A_o.** The wallet signs `{user, agent: A_o, delegate,
  origin, grantHash, …}`, which also narrows replay scope per-origin for
  free. The daemon judges `delegationAuthorizes`
  (`packages/protocol/src/delegation.ts#delegationAuthorizes`) with
  `context.agent = A_o` derived for the surface's origin. The relay's
  structural agent-binding clause cannot survive (it cannot derive A_o
  without the secret); it is dropped for pairwise delegations, and the
  daemon — which was always the authoritative judge, as it already is for
  `origin` — remains the enforcement point. Fail-closed is preserved: a
  delegation naming the wrong A_o dies at the daemon with the same denial.
- **Resume, revocation, fingerprints.** Untouched. The attachment identity is
  client-side; the daemon signs resume proofs with the session's `a_o` (the
  session records its origin); tombstones are origin-keyed since ADR-022's
  addendum; fingerprint words derive from epks.

### D4. The open problem: session routing in the connect tier

`session.open` addresses the agent by key, and the page-side wallet sends it —
so in the drop-in tiers the page must be able to NAME the agent without
learning the root. Two candidate resolutions, deliberately not decided here:

- **R-a (preferred): the relay resolves live pairwise aliases.** During the
  connect-code flow the daemon learns the requesting origin; it derives A_o
  and registers `{A_o → this socket}` with the relay for the socket's
  lifetime. The relay stores nothing durable (ADR-016 holds: the mapping
  dies with the socket, like presence does), and `session.open` targeting
  A_o routes. Cost: one new lifecycle frame (agent→relay alias registration)
  and an alias table with the same lifetime discipline as `#agents`.
- **R-b: the opener never names the agent in page world.** Restructure the
  connect flow so the wallet-held half (which knows root) performs the open
  and hands the page only the session handle. This is cleaner in theory and
  a larger surgery in practice: the drop-in tier's wallet IS in page world
  by construction.

R-a is compatible with today's flow shapes; R-b changes the tier's
architecture. The implementation ADR revision must pick one after prototyping
R-a's relay alias lifetime against reconnect (a redial must re-register
aliases before any page could re-open — the same ordering discipline resume
already has).

## What this does NOT claim

- The relay still sees the root everywhere. Its metadata position is
  unchanged from ADR-018, and the answer for a user who will not accept it
  remains self-hosting. This ADR removes SITE-side correlation only.
- Network-level correlation (IP, timing) is out of scope; pairwise keys do
  not defend against it and nothing here pretends to.
- Origins that collude with the relay operator can correlate. Stated, not
  solved: it is the same trust statement ADR-018 already makes.

## Rollout

Protocol v8, lockstep as always (the proof transcripts change meaning, so
there is no mixed deployment). Order inside the change: D1 derivation with
harness cases; D2/D3 daemon + relay + wallet together behind the version
bump; D4 resolved by prototype before any of it merges. The adversarial e2e
this must carry: two sessions from two origins observe agent identities that
do not match and cannot be linked; an owner-tier client still sees root; a
delegation minted for origin A replayed under origin B dies at BOTH the
origin clause and the agent clause.

The gate this ADR exists to hold: **no store submission before v8 ships
pairwise identity**, because the identifier a stranger's site first sees is
the one it will keep.
