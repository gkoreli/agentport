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

**Decision.** NaCl-box-style sealing with modern spellings, all from `@noble`
libraries already in the dependency tree — no invented crypto:

- Per-session **ephemeral X25519** keypairs, exchanged in the session-open
  frames, each signed over `(sessionId, epk)` by the sender's long-term Ed25519
  identity key. Ephemeral keys give forward secrecy; signatures stop the relay
  swapping keys. Resume re-runs the exchange (fresh key per attachment).
- Shared secret → **HKDF-SHA256** (session id as info) → one symmetric key.
- Every session frame collapses to `{t:'enc', s, n: nonce, c: ciphertext}`
  under **XChaCha20-Poly1305**. The relay sees that a session talks and how
  much — not what, and not even which frame types.
- **Drop-in first contact is TOFU**, honestly labeled: the page key is
  ephemeral and first seen through the relay, so a malicious relay could MITM
  first contact. Mitigations: a short **fingerprint word pair** (derived from
  both epks) shown in the browser modal *and* the daemon consent screen —
  matching words = no MITM, mathematically; plus **key pinning** after first
  contact (SSH model). Paired wallets (known keys both sides) are immune from
  the start.

**Consequences.** Relay-side `mayOriginate()` per-frame-type enforcement cannot
see inside ciphertext; type-level policy moves to the endpoints, which already
enforce it (daemon refuses tools outside the grant; client ignores frames a
peer may not send). The relay keeps its structural checks: only stamped
participants speak, sessions only open toward owned agents. A relay you have
made blind cannot be a policy engine — that division is correct, not a loss.
After this ships, "Cloudflare hosts the relay" carries the same trust weight as
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
