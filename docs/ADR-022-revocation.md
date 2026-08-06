# ADR-022: Revocation — taking it back

- **Status:** accepted (shipped 2026-08-06)
- **Date:** 2026-08-06
- **Depends on:** ADR-016 (stateless relay — ownership lives at the edges),
  ADR-018 (security architecture), ADR-019 (Gate B §5 is the delivery spec),
  ADR-003 (sealing, and what stays visible)
- **Blocks:** ADR-021 §3 (remembered consent may not ship before revocation)
- **Closes:** ADR-018's named blocking gap "there is no revocation UI", and
  ADR-014's open problem of the same name

## Context

The north star lists six things that have to be true. Number four is
*"ownership is provable and revocable — a user key signs 'this is my agent';
the relay can verify but never forge; **the user can take it back**."* The
first three clauses are built. The last one is not: there is no way to see
which origins hold your agent, and no way to cut one off.

Four documents say this differently and one of them is wrong, so it is worth
being exact about what is being asked for:

- **ADR-019 Gate B §5** is the delivery spec, and it is agent-level: list
  owned agents and their fingerprints, revoke an agent, *remove the cert from
  the daemon and disconnect all live sessions*, reject future connections
  using revoked **or absent** ownership state, close affected sessions with a
  stable reason, and provide a CLI path for when the browser is unavailable.
- **`docs/reviews/web-harness-consent.md`** is origin-level: an "origins
  holding your agent" view that separates stored policies from live
  attachments, and three verbs — revoke one origin, end one live attachment,
  kill all. Its seven-step atomicity list is the acceptance bar.
- **`docs/reviews/prior-art-synthesis.md`** puts this first in the build
  order and supplies the shape: Biscuit's signature-as-revocation-id, ZCAP's
  mandatory-expiry-so-the-store-stays-bounded, ssh-agent's `-D`/`-d` verbs,
  and the warning that *revocation designed last is revocation never shipped*
  (ZCAP's own revocation section has been "TODO" for eight years).
- **AGENTS.md** pointed at `CertStore.remove` on the relay as the seam. That
  type no longer exists in source; ADR-016 made the relay stateless and the
  note was corrected in `eaa2009`. Revocation is a daemon + CLI + wallet job
  and never a relay one.

The word "revoke" is doing four jobs across those documents — ownership cert,
per-origin policy, live attachment, and session delegation — with four
different blast radii. Cert removal unpairs the device; per-origin revocation
must emphatically **not**. The first ruling below picks one object and derives
the rest, because four objects would mean four implementations, and the tenets
forbid that.

Two things landed today that change what revocation has to mean:

- **The client now redials automatically** (`c522087`). A dropped socket is
  something the client heals from. So "revoke closed the socket" is no longer
  an ending, and a test asserting it would pass while the property is broken.
- **An approval now binds one exact grant** (`83ab087`). The delegation signs
  a hash of the grant it approved. That makes `SessionDelegation` the object
  that actually carries website-scoped authority, which is what the first
  ruling leans on.

## Decision

### R1. The revocation object is the delegation, addressed by its origin

Not the cert, not the session. `SessionDelegation` is the only protocol object
that carries *website-scoped* authority: it names one origin, one agent, one
page key, one grant, and one expiry, and the origin in it is browser-verified
and signed. "This website may no longer use my agent" is the user's actual
mental model, and it maps exactly onto that object.

Sessions are a consequence, not the target: revoking an origin closes the
sessions opened under its delegations. The cert gets a second, terminal verb
(R6), not a second mechanism.

### R2. Revocation is a tombstone with an instant, not a denylist

`revoke(origin)` records `{origin, at}`. A delegation is refused when
`delegation.origin === origin && delegation.issuedAt <= at`.

A permanent per-origin block would be the wrong shape twice over. It is
membership machinery, and the north star is explicit that the agent "is not a
member of anything — it is attached and then detached". And it would need an
un-block verb, an un-block UI, and a story for what un-blocking means, all to
express something the user can already say by approving again.

With a tombstone, re-approval works the moment the user grants it: a new
delegation carries a later `issuedAt` and is not covered. What revocation
promises is precise — *every authority you have already issued to this origin
is dead* — and it promises nothing about the future, which the user controls
directly.

### R3. Mandatory issuance time and a maximum lifetime; the store is bounded by construction

`SessionDelegation` gains `issuedAt`, and a delegation is invalid unless
`0 < expiresAt - issuedAt <= MAX_DELEGATION_LIFETIME_MS`. The bound goes in
`limits.ts` with its reasoning, like every other bound.

This is ZCAP's rule and it buys two things. A tombstone can be dropped once
`at + MAX_DELEGATION_LIFETIME_MS < now`, because after that no delegation
issued before `at` can still be live — so the revocation store is bounded
without a cap, an eviction policy, or a decision about what to do when it
fills. And it closes a live hole: today nothing stops a wallet signing a
delegation that expires in a decade, so a single approval could outlive the
laptop it was made on.

### R4. Killing the transport is not an ending

Since the client redials and re-resumes by itself, revocation must make a
session **unresumable at the daemon**, not merely closed. Both `session.open`
and `session.resume` consult the tombstones.

For resume that means retaining the `SessionDelegation` on the session rather
than collapsing it to a boolean, because a resume presents **only a bearer
token** — it proves possession, never identity, and the hosted flow resumes
from a freshly minted page key by construction (`site/src/connect.ts` mints a
new keypair on every load). So the delegation is the only thing left tying a
detached attachment to an origin the user may since have cut off.

An earlier draft of this ruling said resume would gain "the ownership check it
has never had". That was wrong, and the code says so: an identity check on
resume would break refresh-resume for every hosted-wallet session. Resume
being a bearer token is a deliberate, documented property (ADR-018), and the
tombstone is the check that a token cannot walk past.

The tombstone on resume is load-bearing in its own right, not a belt on top of
teardown: `agentport revoke` writes the tombstone and never talks to the
daemon, so a live session is unresumable *before* anything is torn down. It is
also what closes the race the consent review names — a resume already in
flight when a revoke lands. It sits after the constant-time token compare, so
a caller who does not hold the token still cannot distinguish a revoked
session from one that never existed.

### R5. Absent ownership is refusal, not permission

`#onSessionOpen` currently reads
`else if (!frame.viaConnect && cert && frame.client !== cert.user)`. With no
cert that branch is vacuous: an unbound daemon accepts any client the relay
stamped, and the property survives today only because the relay independently
refuses. That is invariant 6 held by one edge instead of two.

It also makes R6 actively dangerous: `unpair` removes the cert, so on current
code unpairing would *open* the daemon rather than close it. Unbound must mean
refuse-everything. ADR-019 Gate B §5 already requires exactly this — "reject
future connections using revoked **or absent** ownership state".

### R6. `unpair` is the second verb, and it is terminal

Drop the cert, close every session, redial so the relay sees an unbound agent
and stops announcing it, and refuse everything until the user pairs again.
This is Gate B §5's agent-level requirement and the recovery path for a lost
browser or a suspected key theft. It is deliberately not reachable by
accident: it is the only operation in the system that requires the user to
walk through pairing again.

### R7. The reason is stable and says nothing

Sessions closed by revocation close with reason `revoked`. Not the origin, not
a count, not a message. ADR-019 §5 requires a stable reason revealing no
content; ADR-019 §1 forbids reflecting input into a frame. The client learns
that its authority ended and nothing about anyone else's.

### R8. The instruction crosses the relay as an owner-only lifecycle frame

The user is in a browser, not a terminal. Two new frames: `revoke`
(client→agent, routed by agent pubkey) and `revoked` (the agent's ack,
carrying how many sessions it closed). The relay routes them under the same
ownership rule as `session.open`, with one deliberate difference: **only the
cert's user may send `revoke`, never a delegated page key.** A page holding a
delegation must not be able to revoke — neither its own authority (it already
has `session.close`) nor, far worse, anyone else's.

The relay stores nothing, as ADR-016 requires.

**Disclosure, stated honestly.** The relay learns `{user, agent, origin}` from
a revoke. It already learns exactly that from every `session.open` for the
same origin — `surface.origin` is cleartext lifecycle metadata by design
(ADR-003). So this adds a new *fact* only for an origin the user never
attached to through this relay, and it is added to ADR-018's visible-metadata
list rather than hidden. Hashing the origin was considered and rejected as
theatre: origins are low-entropy and the relay knows the agent key, so any
hash it can see it can also brute-force.

### R9. Tombstones live beside the identity, never inside it

`saveIdentity` is a bare `writeFileSync` — not atomic. Putting revocation
state in that file would put the device secret key one crashed write away from
being lost. Revocations go in their own file, written with the temp-file +
`rename` dance `writePairingControl` already uses, mode `0600` in a `0700`
directory.

### R10. One implementation, two renderers

The CLI and the wallet do not each implement revocation. `AgentDaemon` gains
the operation; the CLI and the wire frame are two callers of it. This is the
"no parallel paths" tenet, and it is also what the prior-art synthesis
recommends ("CLI and UI are views over the same set"). The CLI tier earns its
existence for a documented reason — the browser is unavailable, or the user
has lost the wallet that would have spoken for them — not as a second way to
do the same thing.

### R12. Rebinding requires unpairing first

The daemon used to accept any `pair.bound` the relay sent it: assign the cert,
persist it, done. No signature check, no check that the cert even named this
agent, and — the load-bearing omission — no check that the agent already had
an owner.

That is an ownership-takeover primitive for anything that can make the daemon
begin pairing, and the daemon's own control file is one such thing. Its 200 ms
poll acts on a `request` status, mints a code through the relay, and writes
that code back into the same file. Anything running as the daemon's user can
write the request, read the code, claim it with its own key, and complete the
pairing — and the owner's cert is silently replaced. The agent runtime is
running as that user, in a working directory beside those files, with its own
filesystem tools and no containment (ADR-019 Gate C is not built). A poisoned
page could reach it.

So: an agent that already has an owner refuses a new binding, and the cert
must verify and must name this agent. Rebinding becomes something the user
chose — `unpair` first, deliberately — which is what makes R6 load-bearing
rather than tidy.

This does not close the whole class. An unbound agent can still be claimed by
whoever gets the code first, and a runtime that can rewrite the daemon's own
source can do anything at all. Containment is Gate C's job. What this closes
is the case where a *live, owned* agent changes hands without its owner
knowing.

### R11. Acceptance is adversarial and goes through the reconnect path

The e2e section must prove, over real sockets:

1. Revoke while a session is live → it closes with reason `revoked`.
2. **Then force the socket to drop, and assert the client's automatic
   redial-and-re-resume comes back denied rather than reattached.** A check
   that only proves the socket died would pass while the property is broken.
3. A still-valid delegation for a revoked origin cannot open a *new* session.
4. A delegation issued *after* the revocation instant works — the tombstone is
   not a denylist.
5. Another origin's live session is untouched.
6. After `unpair`, an owner who still holds a valid cert copy is refused
   (absent ownership is refusal).
7. A delegated page key attempting `revoke` is refused by the relay.

Each check is verified non-vacuous by reverting the fix in place, per the
house rule.

## What this does not do

- **No remembered-consent policy store, no policy generation counter, no
  audit view.** Those are the extension's lane (`web-harness-consent.md` R5,
  R6, R11, R13) and they layer on top of this. Revocation gates remembered
  consent; it does not contain it.
- **No per-tool or per-action-class revocation.** The action-class vocabulary
  is build-order item 4 and does not exist yet. Revoking an origin revokes its
  whole grant, which is the honest thing to offer until classes are real.
- **No multi-relay fan-out.** A cert carries no relay metadata, so "revoke
  everywhere" has nowhere to fan out to. Revocation is per-daemon, and the
  daemon is the thing that enforces.
- **No promise about what already happened.** Following the review: revocation
  stops future and not-yet-dispatched work. A tool call that already executed
  cannot be recalled, and the UI copy must not imply otherwise.
- **No containment of the local seam.** `agentport status/revoke/unpair` reach
  files that anything running as the user can read and write, including the
  agent runtime. No choice of IPC fixes that while the runtime shares the
  daemon's uid — file modes and socket permissions are cross-*user* controls.
  What the design does instead is make sure nothing reachable there *grants*:
  every verb only narrows what the agent accepts, and there is deliberately no
  un-revoke and no re-pair. Gate C is what makes the seam safe; until it
  lands, this is stated rather than implied.

## Two honest limits worth naming

**The origin is only as good as who vouched for it.** For a delegated session
the origin was captured by the browser as `MessageEvent.origin`, signed by the
user's key, and re-compared by the daemon against the forwarded surface — that
chain holds. For a drop-in `viaConnect` session the origin is page
self-reported and nothing authenticates it. Revoking still *closes* such a
session (closing needs no authority), but a tombstone cannot bind an origin
string a page invented. That is a property of the connect tier, not of
revocation.

**A pre-approved connect offer is not covered.** The daemon keeps sealing
keypairs minted at connect-offer time, keyed by the client's ephemeral key and
carrying no origin, with no TTL and no sweep. An offer the owner accepted that
never became a session leaves a redeemable keypair that `revoke(origin)`
structurally cannot reach. It is a leak in the connect tier's own lifecycle
and it should get a TTL; it is not something an origin tombstone can fix.

## Trade-offs

**A tombstone is weaker than a denylist, on purpose.** If the user's wallet is
compromised, the attacker can sign a fresh delegation with a new `issuedAt`
and walk straight past every tombstone. That is not a gap in revocation — it
is what "the user key is the root" means, and the answer to a compromised
wallet is `unpair` (R6), which is why both verbs exist.

**`issuedAt` is a wire change, and a lockstep one.** `delegationBody` feeds
`canonicalJson`, which is also the wire encoder, so relay and endpoints deploy
together — the same class of change as `83ab087` and for the same reason. The
two frames in R8 are additive and, being lifecycle frames the relay routes,
also require the relay to deploy first.

**The relay learns a little more.** Stated above and added to the disclosure
list rather than argued away.

## Falsifiability

What would change these rulings:

- **R1/R2:** a real use where the user wants an origin blocked *durably*
  against their own future approval — e.g. a shared machine, or an origin
  they want to be unable to approve in a hurry. That is a wallet-side policy
  ("never offer this origin"), not a daemon-side one, but if it turns out to
  need daemon enforcement, R2 gains a second record type.
- **R3:** if a legitimate flow needs a delegation to outlive
  `MAX_DELEGATION_LIFETIME_MS`, the bound is wrong rather than the rule; the
  tombstone-pruning rule follows whatever the bound is.
- **R8:** if a third-party relay ecosystem appears, a lockstep frame addition
  becomes expensive (`prior-art-synthesis.md` warns that lockstep "dies the
  day third-party relays exist"). The mitigation is to add both frames now,
  while we deploy the relay ourselves, rather than discovering the need later.
- **R4:** if resume authority ever moves off the daemon, the revocation check
  moves with it.
