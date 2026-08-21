# Review: ACP Streamable HTTP & WebSocket transport RFD

Drafted 2026-08-21. **Not yet posted.** Posting is the owner's act, not this
document's.

**Where this goes:** the RFD lives at
[agentclientprotocol.com/rfds/streamable-http-websocket-transport](https://agentclientprotocol.com/rfds/streamable-http-websocket-transport)
with its discussion on
[agentclientprotocol/agent-client-protocol#721](https://github.com/agentclientprotocol/agent-client-protocol/pull/721).
Verified 2026-08-21: status **Active** (so marked 2026-07-02, reflecting
Transports WG focus), targeted as an additive v1 feature, with a reference
implementation in progress in Goose (Phase 2). The security items below are
deferred to a Phase 4 hardening pass and a planned audit; reliability
(SSE resumability, sequencing, reconnection semantics) is deferred to v2.

**The stance, so nobody mistakes it:** this is a contribution, not a
competing proposal. AgentPort runs a remote-agent transport in production
shape today — browser to relay to daemon, both legs WebSocket — and has
already built, adversarially tested, and in two cases *repaired* the exact
mechanisms the RFD defers. We would rather the transport standard absorb
what survives review than keep it as a private moat; the whole point of our
project is to stop being needed. Take what is useful, discard the rest.

---

## What Phase 4 defers, and what we ship for each

The RFD says authentication is "orthogonal and layered on top," and defers
origin validation, the `Acp-Protocol-Version` header, and the security
audit. Each deferral is a place where an implementation shipped against v1
will grow load-bearing behavior that Phase 4 then has to break. The
mechanisms below are not designs — they are running code with adversarial
checks, and each maps onto a deferral one-to-one.

**1. Peer identity: stamped by the transport, never self-reported.**
An `Acp-Connection-Id` names a connection; it does not say *who* is on it.
In AgentPort, every frame that opens a session toward an agent carries the
client identity stamped by the routing party from the *authenticated
socket* — `packages/relay/src/core.ts#openSession` overwrites any
self-reported identity with `conn.pubkey`, and the far end re-checks it
against the presented ownership cert independently, so the property holds
even against a lying router. The transferable lesson: whatever
authentication gets layered on top, the spec should require that
session-opening messages carry a transport-verified principal, not a
client-asserted one. Retrofitting this after SDKs ship self-reported
identity is exactly the migration Phase 4 will otherwise face.

**2. The transport operator cannot read the conversation.**
A hosted `/acp` endpoint — or any load balancer in front of it — terminates
TLS and sees plaintext. That makes the transport operator a silent third
party to every conversation, which for a *user's own agent* is a category
problem, not a hardening item. AgentPort seals all session content
end-to-end above the transport: per-attachment ephemeral X25519, HKDF,
XChaCha20-Poly1305 (`packages/protocol/src/seal.ts#openSealed` is the
receiving half), with key proofs bound to the attachment so they cannot be
replayed across sessions. The e2e suite proves the property with a literal
on-path observer: a recording proxy between client and router sees
ciphertext only. A remote-agent transport spec does not have to mandate
this — but it should *leave room* for it, and cookie/header-level session
semantics that assume the endpoint reads message bodies would foreclose it.

**3. Protocol version inside the authenticated transcript, not beside it.**
The RFD defers `Acp-Protocol-Version` to Phase 4, as a header clients
"SHOULD include." A version carried only in a header is negotiable by
whoever carries the header: an intermediary can present one version to each
end and split-negotiate the weaker rules. AgentPort signs the protocol
version into the key-proof transcript itself
(`packages/protocol/src/seal.ts#epkProofMessage` — the version is part of
what the identity key signs), so endpoints that disagree about the version
fail the proof rather than silently running different rules. This costs one
field in a message that already exists and closes the attack permanently;
as a header it will always be advisory.

**4. Resume authority the routing party cannot use.**
The RFD's session persistence means reconnect-and-resume, and v2 defers the
semantics. The hazard worth designing against *now*: whatever token names a
resumable session will transit the router, and a resume scheme where that
token *suffices* makes the router able to steal any session it routes. We
shipped that bug and repaired it — resume now requires the router-visible
token AND a signature from the attachment identity captured at open
(`packages/daemon/src/daemon.ts#onSessionResume`), so the token alone
transfers nothing, and a failed resume changes no session state. The v2
reliability work should state which parties a resume credential is useful
to; "the token is not an auth token" (which the RFD already says about
`Acp-Session-Id`) is the right instinct and needs the second factor to be
real.

**5. Per-session capability scoping that can change without renegotiation.**
The RFD scopes streams per session but says nothing about what a session
may *do* — reasonably, that is above the transport. One boundary condition
worth importing: when capability grants can change mid-session, narrowing
and widening are not symmetric. In AgentPort, narrowing a live grant needs
nothing (the agent side intersects), while widening requires a fresh
user-signed authorization covering the *new* grant
(`packages/protocol/src/grant.ts#grantWiderThan` is the judge) — otherwise
a connected peer can grow its own authority. If ACP sessions ever carry
capability negotiation over this transport, the asymmetry is the part that
must be in the spec rather than in implementations.

## The browser-shaped hole: cookie affinity

"Clients MUST accept, store, and return cookies set by the server" is
written for SDK clients and reads as a small ask. For a browser-origin
client it is not implementable as written: cookies on cross-origin
requests are third-party cookies (dying platform-wide), `fetch` exposes no
cookie jar to script, and WebSocket handshakes attach cookies by browser
policy, not client choice. The likely outcome is that browser clients
fake affinity in ad-hoc ways per deployment — the least interoperable
possible result for the one client class that cannot ship a workaround.

If a browser profile is in scope for v1 or v2, we suggest: affinity by an
explicit header or query token the client controls (the RFD already has
`Acp-Connection-Id`; letting it serve affinity for clients that cannot do
cookies costs nothing), CORS expectations stated for the `/acp` endpoint,
and origin validation pulled forward from Phase 4 for this profile
specifically — a browser client is precisely the case where the Origin
header is both available and meaningful.

---

## Paste-ready comment for the RFD discussion

We build AgentPort — a browser-to-remote-agent system with the same shape
this RFD standardizes (both legs WebSocket, sessions that outlive sockets,
resume across reconnects). We would much rather contribute what we learned
than maintain a parallel transport, so, offered in that spirit, five things
we ship that map onto the Phase 4 / v2 deferrals, each of which was
adversarially tested and one of which we got wrong first:

1. Session-opening messages carry a **transport-verified principal**, never
   a self-reported one — retrofitting this after SDKs ship is painful, and
   it is cheap now.
2. **End-to-end sealing above the transport** (the operator of the endpoint
   or LB sees ciphertext). Not asking the spec to mandate it — asking that
   session semantics not assume the endpoint reads bodies, so it stays
   possible.
3. **Protocol version signed into the key/auth transcript**, not carried as
   an advisory header — a header-only version invites split-negotiation by
   an intermediary. This is one field in an existing message.
4. **Resume = token AND proof by the identity captured at open.** We
   shipped token-only resume, and it made the router able to steal any
   session it routed; the repair is documented and tested. Worth stating in
   the v2 reliability work which parties a resume credential is useful to.
5. For a **browser profile**: cookie-mandated affinity is not implementable
   from a cross-origin browser client — an explicit header/query token
   (`Acp-Connection-Id` already exists), stated CORS behavior, and
   origin validation pulled forward would make browser clients first-class
   instead of per-deployment hacks.

Happy to expand any of these with the concrete mechanisms and test
harnesses if useful to the working group.
