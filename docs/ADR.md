# AgentPort — Architecture Decision Records

One file, one numbered record per decision. Statuses: **accepted** (built or being
built), **planned** (decided, not yet built), **rejected** (considered, not doing),
**deferred** (doing later, deliberately not now).

The one-line thesis these decisions serve: *today every app owns an isolated
chatbot and pays for its inference; the user should own one agent and carry it
between applications.* A site lends the user's agent site-defined tools for one
session; the user brings the agent, the model, the memory, and keeps the data.

---

## ADR-001: A relay is the rendezvous, and that is unavoidable — accepted

**Context.** The two endpoints are a browser tab and a daemon on the user's
machine. A tab cannot accept inbound connections (no listening sockets in page
JS). The daemon deliberately opens no inbound ports. Two parties that can only
dial out need an always-reachable meeting point.

**Decision.** Both sides dial out over `wss://` to a relay that matches them and
routes frames. There is no "zero relay" architecture anywhere in this space —
Tailscale has DERP servers and a coordination server; WebRTC has signaling
servers; WalletConnect has its relay. The achievable property is not *no relay*
but *no trusted relay* (ADR-003) plus *direct when possible* (ADR-011).

**Consequences.** The relay is ~200 lines of "match two websockets, check
signatures" (`RelayCore`), portable across Node and Cloudflare. Anyone can
self-host it; the daemon's `AGENTPORT_RELAY` env var is the only coupling.

---

## ADR-002: Tailscale is not the transport — accepted

**Context.** Tailscale looks like it should solve this: encrypted pipes, no open
ports, no hosting. Investigated seriously, twice.

**Decision.** Rejected as the transport, for one structural reason: the far
endpoint is a webpage on an arbitrary site in an arbitrary browser, and a
browser tab cannot join a tailnet (WireGuard needs an OS network interface).
Tailscale connects *machines you enroll* to each other; AgentPort connects
*strangers* to your machine with consent. Enrollment is the antithesis of the
trust model. Tailscale Funnel technically reaches the open web but gives the
agent one stable public URL every site learns (linkable identifier, scan/DDoS
target), still needs a rendezvous story, and bets the product on another
company's ToS and bandwidth caps.

What we take from Tailscale instead are its two real lessons: relays must be
blind (ADR-003) and paths should be direct when topology allows (ADR-011).
Tailscale on the VPS remains a fine *optional* way to reach direct mode
privately from the user's own enrolled devices.

**Consequences.** We own a small relay and a sealing layer rather than
depending on a VPN that cannot reach half the connection.

---

## ADR-003: Seal session frames end-to-end; the relay becomes a blind courier — accepted (shipped 2026-07-31)

**Context.** Both legs are TLS, but TLS terminates at the relay, so the relay
operator (currently Cloudflare) can read frames in flight. This is the single
largest gap in the "user's session, user's data" claim. Prior art proves the
fix is routine: WalletConnect v2 and Paseo both run E2E boxes over untrusted
relays (Paseo: Curve25519 ECDH + XSalsa20-Poly1305, relay sees only
IPs/timing/sizes/session ids).

**Decision.** A Noise-inspired channel using the browser-safe `@noble`
primitives already in the dependency tree. Noise's `CipherState`, `Split`,
prologue, and failure rules are the normative design reference; libsodium's
`crypto_kx` and `secretstream` APIs are the secondary implementation reference:

- Per-attachment **ephemeral X25519** keypairs, exchanged in the session-open
  frames. Ed25519 proofs bind the epks to the canonical handshake context:
  session/mode, both peers, surface, capability grant, and resume authority as
  applicable. The relay cannot swap keys or rewrite lifecycle metadata without
  invalidating the handshake. Resume re-runs the exchange.
- Shared secret → **HKDF-SHA256** (session id and direction as info) → separate
  client→agent and agent→client keys. Each direction owns a strict monotonic
  64-bit nonce; tampering, replay, reordering, or exhaustion fails closed.
- Every content frame collapses to `{t:'enc', s, n: nonce, c: ciphertext}`
  under **XChaCha20-Poly1305**, with the visible session id authenticated as
  associated data. Lifecycle frames stay visible because the relay routes
  them. The relay cannot see content or its frame type.
- Sealing is mandatory on open and resume. Missing key material, invalid key
  proofs, plaintext content, and malformed ciphertext are rejection states;
  there is no compatibility or downgrade path.
- **Drop-in first contact is TOFU**, honestly labeled: the page key is
  ephemeral and first seen through the relay, so a malicious relay could MITM
  first contact. A six-word, 48-bit short authentication string derived from
  both epks is shown in the browser modal *and* the daemon consent screen for
  deliberate out-of-band comparison. Paired wallets know the agent key and
  authenticate the exchange without relying on that comparison.

**Consequences.** Relay-side `mayOriginate()` per-frame-type enforcement cannot
see inside ciphertext; type-level policy moves to the endpoints, which already
enforce it (daemon refuses tools outside the grant; client ignores frames a
peer may not send). The relay keeps its structural checks: only stamped
participants speak, sessions only open toward owned agents. A relay you have
made blind cannot be a policy engine — that division is correct, not a loss.
With this shipped, "Cloudflare hosts the relay" carries the same trust weight as
"Tailscale routes packets through DERP": none.

---

## ADR-004: ACP is the agent runtime; `mcpServers` is the capability seam; `loadSession` is the provenance store — accepted

**Context.** We need to drive a real agent (Claude Code) and inject site tools
for exactly one session, and we need conversation history that belongs to the
user, not the site or the relay.

**Decision.** The daemon is an ACP *client* via `@agentclientprotocol/sdk`,
spawning `@agentclientprotocol/claude-agent-acp`. Two ACP features carry the
whole design:

- `session/new` accepts `mcpServers[]` — the daemon runs a loopback-only HTTP
  MCP bridge (per-session bearer token) serving the site's granted tools, and
  hands it to the agent for that session only. Temporary capability injection
  is a *native ACP concept*, not a hack.
- `loadSession: true` — the agent persists conversations on the user's disk.
  History restoration replays from there. We wrote zero agent code and zero
  transcript store.

**Consequences.** Any ACP-speaking agent is a supported runtime. The daemon
stays an orchestrator. Known gap: the daemon's session-id ↔ ACP-session-id
mapping should persist across daemon restarts.

---

## ADR-005: Provenance — the transcript lives only on the user's machine — accepted

**Context.** User requirement, verbatim: "all the data belongs to the user...
user's session, user's data and full privacy." An early implementation cached
the transcript in the site's sessionStorage and, separately, buffered missed
frames in the relay. Both were rejected as provenance violations.

**Decision.** Exactly one durable copy of the conversation exists: the agent's
own ACP session store on the user's disk. The site keeps only a resume record
`{sessionId, token, relay, surface}` — no content. The relay, when a client
drops, holds the session open (5-minute orphan grace) but **counts and drops**
agent frames rather than buffering them: a count is routing metadata; the
frames are the user's data. On refresh, the page re-attaches with the token and
hydrates history *from the agent side* (`history.request` → ACP `loadSession`
replay).

**Consequences.** A page refresh round-trips through the user's own machine to
restore the UI. The relay stores nothing readable even before ADR-003 sealing.

---

## ADR-006: Adopt WebMCP as the tool-declaration layer; AgentPort is everything above it — planned (priority 4)

**Context.** WebMCP (`document.modelContext`, formerly `navigator.modelContext`)
is a W3C Draft CG Report edited by Google/Microsoft engineers, shipped in
Chrome 146, origin-trialing in 149. As of July 2026 it has browser support and
site-side tooling but **no mainstream agent consumers and no story for remote
or external agents** — the spec deliberately scopes out agent identity, trust,
transport, and consent. Meanwhile the remote-daemon projects (Paseo, Remote Pi,
OpenClaw) connect agents only to their *owners*, never to third-party sites.

**Decision.** Stop asking sites to adopt a proprietary tool format. Harvest
WebMCP registrations (`document.modelContext`, with the deprecated
`navigator.modelContext` probed for compatibility) in both connect.js and the
extension, mapping them into the session grant. Position AgentPort as the layer
WebMCP explicitly lacks: **identity (AgentCert), transport (relay/direct),
session scoping (grants + TTL), and consent (approvals)** for an agent the
user owns, running elsewhere. WebMCP declares the tools; AgentPort is how
*your* agent reaches them safely.

**Consequences.** Every WebMCP-adopting site becomes AgentPort-compatible with
zero AgentPort code. Our `SiteTool` API remains as the fallback and the richer
option (approval gating metadata). Positioning: completing a standard, not
proposing one.

---

## ADR-007: The connect UI is in-page glass (WalletConnect shape), not an iframe — accepted

**Context.** Shop Pay achieves cross-merchant recognition with an
iframe/popup on its own origin holding first-party storage. WalletConnect
renders a plain in-page modal. Which shape is ours?

**Decision.** In-page component (nisli html layer, closed shadow root), because
— like WalletConnect and unlike Shop Pay — **nothing in the page is worth
stealing**. The page holds an ephemeral key that can approve nothing; all trust
decisions happen at an out-of-band anchor (the daemon today, the extension or
phone later). A pixel-perfect fake modal gains an attacker nothing. Shop Pay
needs its own-origin popup only because it wants the *browser* to recognize the
user with no companion device or extension; we have a companion by definition.
Note for any future hosted-wallet tier: browsers now partition third-party
iframe storage, so cross-site memory requires a top-level **popup** on the
wallet origin, not an iframe.

**Consequences.** Zero-install works everywhere a script tag works. Sites
CSP-whitelist one constant relay origin — the same integration shape as
Stripe/Shopify (fixed known origins), which is what makes third-party adoption
realistic.

---

## ADR-008: Three wallet tiers; the extension is tier two, not the foundation — accepted / in progress

**Context.** "Run once on the VPS and never touch it again" requires approvals
and session-opening to live in the browser. The per-site terminal command
(`npm run connect CODE`) belongs only to the keyless drop-in path.

**Decision.** Three coexisting tiers, each a superset of convenience:

1. **Drop-in code flow** (universal, zero install) — page shows a code, the
   owner claims it where the key lives. The stranger-machine fallback, forever.
2. **Extension wallet** (one-tap) — holds the user key and AgentCerts; pair
   once, then connect.js detects it and routes `session.open` + approvals
   through it. Picker → tap → session. No terminal, no codes.
3. **Hosted wallet popup** (Shop Pay tier) — browser-side memory with no
   install. **Deferred** until tiers 1–2 are complete; only needed for
   remembered-agents on machines with neither extension nor phone.

**Consequences.** The Chrome Web Store is never a gate: tier 1 needs no
install, and tier 2 develops and daily-drives as an unpacked extension.
Store publication ($5 fee, days-long review) is a distribution nicety;
request `activeTab` + optional host permissions rather than blanket host
access to keep review fast and posture honest.

---

## ADR-009: One-tap must not create a supercookie — planned (requirements for tier 2)

**Context.** Moving the user key into the browser and showing "Goga's VPS
Agent" to every site would (a) put a long-lived key on a larger attack surface
and (b) hand sites a stable cross-origin identifier — cross-site tracking for
free. Shop Pay makes exactly this trade badly; we don't copy it.

**Decision.** Three properties are part of the feature's definition, not
hardening to add later:

- **Pairwise per-origin identity** (the passkey move): sites see a stable
  identifier *for their origin only*; display names shown to sites are
  generic. Nothing correlates across origins. The relay still sees the true
  agent key — which is why ADR-003 sealing and self-hostable relays are the
  other half.
- **Approvals render in extension chrome** (popup/notification), never as
  in-page overlays a site could imitate or clickjack. The terminal's virtue —
  a page cannot draw pixels there — must survive the move to the browser.
- **Key wrapped at rest**, unlocked per browser session; and the **daemon
  keeps `alwaysAsk` as a second gate** on dangerous tools, so a compromised
  browser wallet still cannot silently exercise the agent's sharpest
  capabilities.

**Consequences.** With these, tier 2 matches tier 1's privacy; without them it
is strictly worse. Reviewed as blocking requirements on the tier-2 PR.

---

## ADR-010: The daemon is always-on and only dials out — accepted

**Context.** "Why do I have to run a command on my VPS every time?" The answer
must be: you don't; you run one command once.

**Decision.** `deploy/agentport.service` — systemd unit, `Restart=always`,
dial-out only (no inbound ports, no firewall rules), `UMask=0077` on the device
key, `NoNewPrivileges`/`ProtectSystem` hardening, journald logging. Install
once, pair once, and the VPS terminal exits the user's life; everything after
is browser-side (ADR-008).

---

## ADR-011: Direct mode — the relay leaves the data path where topology allows — planned (priority 5)

**Context.** With a public VPS there is no NAT problem; the only reasons frames
transit a relay are rendezvous and the browser's inability to listen. When the
*user's daemon* is publicly reachable, the browser can simply dial it.

**Decision.** Add a listening transport: daemon behind Caddy (auto
Let's Encrypt) at a user hostname, browsers connect `wss://agent.example.com`
directly — TLS terminates on the user's machine, true A→B, relay uninvolved.
The protocol is transport-agnostic; only the socket changes. Optionally reached
over the user's tailnet (`tailscale serve` + `ts.net` certs) for
own-devices-only privacy. Relay mode remains the default for third-party sites:
their CSP can whitelist one constant relay origin but not every user's personal
hostname, and a stable personal hostname is a linkable identifier the code flow
exists to avoid. WebRTC DataChannels (relay demotes to signaling, direct DTLS
even without a public IP) are the eventual generalization; sealed-relay
(ADR-003) is its mandatory fallback and ships first.

---

## ADR-012: Cloudflare Workers host the reference relay and site — accepted

One Worker serves the static site and routes `/relay` to a Durable Object
wrapping the same `RelayCore` the Node host uses (`run_worker_first` so the
asset router doesn't eat the path; `@agentport/relay/core` subpath export so
Workers never import `node:fs`/`ws`). Free tier, zero ops. After ADR-003 the
choice of relay host is trust-irrelevant by construction; self-hosting remains
one env var away.

---

## ADR-013: No in-browser agent runtime (WebContainers et al.) — rejected

**Context.** WebContainers/Nodebox/Nodepod/BrowserPod can run Node in a tab;
"run the agent in the page and skip the VPS" is tempting.

**Decision.** Rejected for the architecture: a tab-resident agent dies with the
tab (no persistence, no provenance, no resume), runs on the *site's* context
(reinventing the per-app chatbot AgentPort exists to kill), can't reach the
user's real files/MCP servers, and would hold model credentials in page memory
on a foreign origin. At most a future zero-install *demo mode* (throwaway
in-tab agent to demo the connect flow); if built, use an open runtime
(Nodebox/Nodepod), not license-encumbered WebContainers.

---

## ADR-014: Named open problems — accepted as honest

Recorded so nobody mistakes silence for safety:

1. **Prompt injection into a borrowed agent** — the sharpest unsolved risk, for
   us and everyone. Site content flows into an agent holding the user's *own*
   tools (mail, files, calendar); a poisoned page could try to exfiltrate
   through tools the site never lent. The injection-hardening preamble is a
   sentence, not a control; the daemon-side approval gate is the only real one.
   Containment work (per-session tool allowlists on the agent's own tools, not
   just the site's) is future work.
2. **Drop-in first contact is TOFU** until the fingerprint check (ADR-003) —
   and self-reported origin in connect mode means a malicious site can lie
   about its name on the consent screen; only the extension gets attested
   `port.sender.origin`.
3. **No revocation UI** — `CertStore.remove` exists; nothing calls it.
4. **Daemon restart loses the ACP session-id mapping** (ADR-004).

---

## Execution order (as of 2026-07-31)

| # | Work | ADR | Size |
|---|------|-----|------|
| 1 | Seal relay frames (E2E) + fingerprint + pinning | 003 | ~1 day |
| 2 | Enable systemd unit on the VPS (rsync latest, one command) | 010 | ~10 min |
| 3 | Extension one-tap: detect wallet, pairwise identity, chrome approvals | 008, 009 | ~2–3 days |
| 4 | WebMCP harvesting + repositioning | 006 | ~1 day |
| 5 | Direct mode (Caddy listener; optionally tailnet) | 011 | ~1–2 days |

---

## ADR-015: Open-source product, not a standards protocol; name stays AgentPort — accepted

**Context.** Three claimants on the name surfaced: npm `agentport` +
`agentport-cli` (an unrelated skills framework) and agentport.dev (YC W26,
MCP-tools-for-merchants — supply side of our thesis, complementary product,
colliding brand). A rename to AgentWallet was fully executed, then reverted
(crypto connotations); portcall/callport were explored and dropped
(portcall.com is an active maritime software company; the good English words
are all partially claimed).

**Decision.** Two-part identity call:

- **Open-source product, not a standards-track protocol.** Protocols evolve at
  committee speed; products become de-facto standards by shipping (the
  WalletConnect path — never went through a standards body). Packaging
  existing pieces well — ACP, WebMCP, WalletConnect patterns, systemd,
  Cloudflare — *is* the product, the way Tailscale packaged WireGuard. Code is
  the spec; MIT it; hosted defaults that just work; self-host if paranoid.
- **The name stays AgentPort.** The collision only bites at npm publish and
  public launch; revisit then. Publish options when the time comes:
  `@agentport/cli` (scope appears free) or `@gkoreli/agentport`.

**Consequences.** No standards-body dependency on our own layer (we still
*consume* WebMCP, ADR-006). `navigator.agent` remains the API name regardless
of brand.

---

## ADR-016: Decentralize by subtraction — stateless plural relays, then direct paths, then Nostr rendezvous — accepted (rung A core shipped 2026-08-02; CODE@relay URIs and multi-relay pending)

**Context.** ADR-012 made Cloudflare the reference host; sealing (ADR-003) made
it blind. But the relay still *remembers* things — sessions, resume tokens,
certs — and an earlier plan to persist session records into DO storage would
have deepened that coupling. The owner's correction: state belongs at the
edges; every byte the relay holds is dependence on whoever hosts it.

**Decision.** Decentralization proceeds by removing relay responsibilities,
in three rungs:

**A. Stateless, plural relays** (next implementation work):
- Session authority moves to the daemon. It already holds grant, seal key,
  client identity and (via ACP loadSession) the conversation. The daemon mints
  and verifies resume authority; `session.resume` becomes a forwarded request
  the AGENT answers, not a relay-table lookup. A relay restart loses nothing:
  both ends redial (daemon already does) and re-establish from edge state.
- Certs verified at connection time, stored nowhere relay-side. The daemon
  presents its cert on identify (already does); the relay verifies the
  signature and keeps it in connection memory only. Offline-agent directory
  comes from the wallet's own cert store (the extension already has one).
- Invariant 5 ("only reach agents you own") moves to the daemon: it compares
  the relay-stamped client key against its own cert.user. Enforced at the
  edge, where the trust actually lives.
- Connect codes become WalletConnect-style URIs carrying their rendezvous:
  `CODE@wss://relay.host`. Any relay works per-session; the daemon may sit on
  several relays at once. The relay ends as ~200 lines of verify-stamp-forward
  + rate limiting, zero storage, zero migrations. Cloudflare demotes to "one
  default host of a commodity component".

**B. Direct data path (WebRTC).** Relay demotes to signaling; session traffic
flows browser<->daemon over DTLS DataChannels. Sealed-relay remains the
mandatory fallback (ADR-011 already sketches this).

**C. Nostr rendezvous.** Precedent: Nostr Wallet Connect runs exactly this
shape for Bitcoin wallets — pairing + encrypted messaging over the public
Nostr relay network, pubkey addressing, no proprietary servers. AgentCert maps
onto a user-signed Nostr event; discovery/signaling ride relays nobody owns;
our ws relay becomes one transport adapter among several. This is also where
the project's original Buzz/Nostr instinct lands.

**Consequences.** DO-storage session persistence is DROPPED (only the existing
cert persistence remains until rung A removes the need). Relay-side session
state becomes an implementation detail of one transport, never the product's
memory. The "relay can be run by anyone" claim becomes literal: stateless
forwarders are fungible.

---

## ADR-017: Adopt AG-UI as the UI-event edge, via an adapter — accepted

**Context.** AG-UI standardizes the agent→UI event stream (text deltas, tool
call lifecycle, state sync, human-in-the-loop) with a growing ecosystem of
ready renderers (CopilotKit et al.). It is perpendicular to WebMCP: WebMCP is
the site→agent capability direction, AG-UI is the agent→screen direction. A
single AgentPort session uses both at once. Neither defines identity, grants,
consent, or transport — the middle stays ours (same finding as ADR-006).

**Decision.** Integrate as an ADAPTER at the client edge, not as the wire
format:

- Ship `@agentport/agui`: translate a live `AgentSession` into an AG-UI event
  stream (`delta` → TEXT_MESSAGE_CONTENT, `tool.call`/`tool.result` →
  TOOL_CALL_*, `thought` → thinking events, `approval.request` → the
  human-in-the-loop pattern). Any AG-UI-compatible component can then render
  an AgentPort session with zero custom code.
- Our SessionFrame vocabulary REMAINS the sealed wire format. It carries what
  AG-UI has no words for (epk handshakes, grants, resume, approval authority),
  and interop has no value inside ciphertext — only at the edges where other
  people's code runs.
- Revisit aligning the inner content vocabulary with AG-UI only if it clearly
  wins its layer; premature while the spec is young.

**Consequences.** The standardized stack positioning is complete: WebMCP at
the input edge (ADR-006), ACP at the runtime (ADR-004), AG-UI at the output
edge (this), AgentPort as the trust-and-transport middle none of them define.
One sentence: WebMCP tools in, AG-UI events out, your agent in the middle,
nobody in between.

---

## ADR-018: Security architecture is explicit, fail-closed, and enforced at the edges — accepted

**Context.** ADR-003 decides how session content is sealed, but cryptography is
only one part of AgentPort's security boundary. Ownership, consent, capability
scope, resume authority, transcript provenance, endpoint policy, metadata
disclosure, and prompt injection span several packages. Keeping those claims
only in implementation comments or agent working notes makes contradictions
easy and security review unnecessarily difficult.

This record is the authoritative current security model. Earlier ADRs explain
why individual decisions were made; if a historical statement conflicts with
this record or the shipped protocol, this record and the executable invariants
win. AgentPort is not independently audited, and must not be described as such.

**Decision.** AgentPort treats the relay and the site as mutually untrusted
intermediaries, keeps authority and durable user data at the endpoints, and
fails closed whenever authentication, sealing, grant, or message-state checks
cannot be proved. There is no plaintext, compatibility, or heuristic recovery
path for session content.

### Security tenets

1. **No silent downgrade.** All conversation, history, tool, and approval
   frames are sealed. Missing or invalid key material never selects a weaker
   transport.
2. **Authenticate the entire decision context.** Ephemeral-key proofs bind the
   mode, peers, surface, capability grant, and resume authority applicable to
   that exchange. Cleartext lifecycle metadata may be observed, but cannot be
   rewritten undetectably.
3. **Least authority, for one attachment.** A grant names the only site tools
   available, records approval policy, and expires. The daemon and client both
   enforce it; the relay is not a capability authority.
4. **Authority and durable data live at the edges.** User and device secret
   keys, resume authority, transcripts, and runtime state do not belong to the
   relay. The relay keeps only live-socket routing state.
5. **Consent renders outside the requester where a trusted surface exists.**
   Paired-wallet consent belongs in extension chrome; drop-in consent belongs
   at the daemon. An arbitrary site must not be able to impersonate approval.
6. **Metadata is disclosed honestly.** Encryption hides content, not traffic
   analysis or the lifecycle fields required for rendezvous and consent.
7. **Security properties are executable.** A routing, identity, grant,
   sealing, resume, or persistence change is incomplete without an adversarial
   end-to-end check for the affected invariant.
8. **Replacement removes the old path.** A new security mechanism is consumed
   immediately and the superseded mechanism is deleted in the same change.

### Assets and trust boundaries

| Component | Holds or sees | Security position |
|---|---|---|
| Site/surface | Its tool implementations and results; prompts and agent output intentionally delivered to its tab | Untrusted requester and application-side plaintext consumer. The wallet/client is the cryptographic endpoint. Site content and tool results are hostile input. In the in-page demo the site can also reach the demo wallet key, which is why that arrangement is not a production custody boundary. |
| Wallet/client | User identity key, owned-agent certs, grant decision, site-tool dispatch, attachment keys | Trusted endpoint. Production custody and approvals belong behind the extension boundary. |
| Relay | Public identities and certs, lifecycle frames, live routing state, ciphertext metadata | Untrusted for content confidentiality and integrity; relied on only for availability, rendezvous, identity stamping, and best-effort routing. Endpoint checks remain valid against a lying relay. |
| Daemon | Agent device key and cert, grants, resume tokens, attachment keys, transcript/runtime session mapping | Trusted endpoint and final policy authority. It re-checks ownership, grant expiry, tool membership, approvals, resume authority, and client frame types. |
| ACP runtime | Plaintext conversation and the user's own runtime capabilities | User-selected trusted computing base, but model output and retrieved content are not trusted instructions. Runtime auto-approval is forbidden. |
| Network observer | TLS records outside the relay; timing and endpoints | TLS protects each relay leg. E2EE additionally protects content from the TLS-terminating relay. |

The protected assets are the user and agent secret keys, attachment secrets,
conversation content, tool arguments/results, approval decisions, resume
authority, capability scope, transcript, and the user's runtime capabilities.

### Adversaries covered

- A curious or malicious relay that records, drops, reorders, replays,
  modifies, or substitutes frames and ephemeral keys.
- A network observer on either relay leg.
- A site attempting to exceed its grant, forge agent-originated frames,
  bypass approval, resume another session, or reach an agent it does not own.
- A non-participant socket attempting to inject session traffic.
- Replayed ciphertext, handshake proofs, resume attempts, and modified
  lifecycle metadata.
- Hostile page text or tool results attempting prompt injection. This risk is
  contained by explicit approval and grant boundaries, not solved by E2EE.

### Cryptographic channel

ADR-003 and `packages/protocol/src/{channel,seal}.ts` define the channel. Each
open or resume attachment creates fresh X25519 keys. Ed25519 signatures prove
the ephemeral keys against canonical, domain-separated handshake bindings.
X25519 output is rejected if all-zero. HKDF-SHA256 derives independent
client-to-agent and agent-to-client keys. XChaCha20-Poly1305 seals content with
the visible session id as mandatory associated data.

Each direction starts at nonce zero and accepts exactly the next 64-bit
counter. State advances only after successful AEAD authentication. Tampering,
replay, reordering, nonce exhaustion, wrong associated data, and malformed
ciphertext therefore fail closed. Loss or reordering can sacrifice
availability: the attachment must resume with fresh keys rather than guess at
counter recovery.

The channel provides per-attachment forward secrecy: later compromise of an
identity key does not recover recorded content if ephemeral secrets were not
also captured. It does **not** provide an intra-attachment ratchet or
post-compromise security. Compromise of a live wallet, daemon, runtime, or
attachment key exposes the content available to that endpoint.

Paired sessions authenticate the agent key already certified to the wallet and
the daemon re-checks that the stamped client owns it. Drop-in first contact is
TOFU: its ephemeral page identity first arrives through the relay. The
six-word, 48-bit short authentication string only detects a MITM when the user
actually compares both consent surfaces. It is not identity pinning.

### What the relay can observe

Content frames expose only `{t: "enc", s, n, c}` plus WebSocket/TLS metadata.
The relay can observe session id, direction, timing, frequency, ciphertext
length, and the network endpoints connected to it. AgentPort does not pad
frames or conceal traffic shape.

Lifecycle traffic remains clear and includes, depending on the flow:

- protocol version and socket role;
- public identity keys, ownership certs, signatures, presence, and pairing or
  connect codes;
- surface name, claimed origin and route;
- the capability grant: tool names, descriptions, schemas, approval flags,
  `alwaysAsk`, and expiry;
- client, agent, and ephemeral public keys and their proofs;
- agent name/runtime, session status, denial and close reasons, and missed
  frame counts;
- the resume bearer token while a resume/open response is in transit.

These fields are authenticated where they affect the session decision, but
they are not confidential. The relay stores none of them durably; seeing a
resume token in transit is different from minting, judging, or retaining it.
The daemon owns resume authority and rejects token guessing with a bounded
attempt count, constant-time comparison, and a generic unprovable-session
response.

### Capability, content, and provenance boundaries

- The daemon rejects expired grants and tools absent from the grant. The
  client dispatches only tools registered for that session. Approval defaults
  to denial; drop-in approval moves to the daemon rather than disappearing.
- Because the relay cannot inspect encrypted inner types, both endpoints
  enforce which content-frame types the peer may originate. Relay-side role
  checks remain for visible lifecycle frames and session membership.
- The conversation's durable copy belongs to the agent runtime on the user's
  machine. The relay never buffers content and the site never persists a
  transcript across reload. History restoration asks the daemon/runtime.
- The site may persist only the session id, agent address, relay address,
  surface selector, and resume token required to reattach. The extension also
  records the origin/name lookup key and grant expiry in extension-only session
  storage. A resume token is a bearer secret scoped to its existing session
  and still bounded by the original grant and expiry.
- Session attachment keys live in endpoint memory and are removed when the
  session closes. JavaScript cannot guarantee physical zeroization; the design
  therefore relies on ephemerality, non-persistence, and short ownership.

### Fail-closed rules

- Invalid certs, identity signatures, peer ownership, or session membership
  are rejected.
- Missing/invalid ephemeral keys or proofs abort open/resume.
- Plaintext content frames are dropped; content is never retried unsealed.
- AEAD failure, counter mismatch, or forbidden inner frame type is dropped
  without advancing receive state.
- Expired grants, unknown tools, declined approval, invalid resume authority,
  and attempts to replace a live attachment are denied.
- Malformed JSON and frames without an object envelope and string type are
  rejected. Exhaustive per-frame runtime schema validation is a blocking gap
  recorded below.
- Transport failure may interrupt the operation; it never changes the
  security tier.

### Enforcement and evidence

| Invariant | Primary enforcement | Required evidence |
|---|---|---|
| Ownership cert cannot be forged or rebound | protocol signature helpers; relay identify; daemon owner re-check | invalid cert/binding checks in `scripts/e2e.ts` |
| Relay-stamped identity is authoritative | relay session routing; daemon open/resume handling | self-reported identity substitution test |
| Grant is the tool boundary | daemon `callTool`; client session dispatcher | ungranted and expired tool checks |
| Only participants and valid roles speak | relay membership/origination checks; endpoint inner-type allowlists | cross-role and non-participant injection checks |
| Content is always sealed | protocol sealing; wallet and daemon send/receive boundaries | on-path observer plus plaintext-proof stripping checks |
| Handshake metadata cannot be rewritten | canonical epk proof bindings | grant-rewrite and missing/invalid proof checks |
| Ciphertext is ordered and authentic | channel counter and AEAD state | tamper, replay, wrong-AAD, and counter tests |
| Resume preserves authority and rekeys | daemon-owned token/grant state; fresh endpoint epks | theft, live-session replacement, expiry, and rekey checks |
| Conversation remains at the edge | daemon/runtime history; relay count-and-drop behavior | refresh replay proves history came from agent side |

`npm run e2e` is the minimum acceptance test for these invariants, alongside
the TypeScript builds for protocol, browser, Worker, and examples. A test whose
assertion cannot fail for the claimed property does not count as evidence.

### Known blocking gaps

- `decodeFrame()` currently validates only JSON, an object envelope, and a
  string `t`; TypeScript wire types do not validate hostile runtime input.
  Exhaustive, size-bounded schemas for every frame must replace that shallow
  boundary before the protocol is called production-hardened.
- The E2E suite covers ownership denial, grant restriction, approval refusal,
  on-path observation, tampering, replay, proof stripping, grant rewriting,
  resume-token theft, and edge-owned history. It does not yet directly attack
  invalid cert rebinding, self-reported identity replacement, grant expiry,
  every cross-role/non-participant route, or compare old and resumed
  attachment keys. Those rows above remain required test work, not implied
  coverage.
- Production key custody and origin attestation still depend on completing the
  extension boundary. The in-page wallet remains demo-only.
- There is no revocation UI, and prompt injection containment for the runtime's
  unrelated personal tools remains incomplete (ADR-014).

### Explicit limitations and non-goals

AgentPort does not protect against a compromised endpoint, malicious or
compromised runtime, vulnerable browser extension, stolen unlocked device,
dependency compromise, or a user approving a dangerous action. It does not
hide IP addresses, timing, message sizes, lifecycle metadata, or denial of
service. It does not make hostile site content safe for an agent with unrelated
personal tools. It currently provides no post-quantum security.

The in-page wallet is a demo tier, not production key custody. Claimed origin
in drop-in mode is self-reported; only the extension boundary can attest the
embedding origin. The approval boundary is the primary control for prompt
injection until stronger isolation of the runtime's own tools ships.

### Change discipline

Any change to identity, pairing, lifecycle fields, grants, routing, sealing,
resume, consent placement, persistence, or transcript handling must update
this record and its adversarial tests in the same change. New cryptographic
design must cite an open standard or established implementation, preserve
browser compatibility, and receive focused review. Backward compatibility may
justify a new explicit protocol version; it never justifies accepting
plaintext or unauthenticated content under the current version.

**Consequences.** Security claims now have one reviewable source tied to code
and executable evidence. The cost is intentional: protocol changes carry a
documentation and adversarial-test obligation, metadata cannot be hand-waved
as encrypted, and availability is allowed to fail before confidentiality or
authority does.
