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

**Consequences.** The relay is one file of "match two websockets, check
signatures" (`RelayCore`, ~740 lines and growing mostly in bounds and rate
limits, not in state), portable across Node and Cloudflare. Anyone can
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
  both epks is shown on the daemon consent screen *before* the owner approves,
  and in the page's own session panel (`session.info.verify`) *after* the
  attachment opens. **The connect modal does not show it**, so the two
  surfaces are never on screen together and the comparison is a
  detect-and-detach check rather than a pre-approval one — a real weakness in
  the tier that relies on it most, recorded here rather than implied away.
  Paired wallets know the agent key and authenticate the exchange without
  relying on that comparison.

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
  *durable* transcript store — the daemon keeps a bounded in-memory transcript
  per session as a fallback for runtimes that persist nothing, and the
  runtime's own `replayHistory()` wins whenever it returns non-null.

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
`{id, agent, token, relay, surface}` — no content. The DAEMON, when a client
drops, holds the session open (`DETACH_GRACE_MS`, 30 minutes) but **counts and
drops** agent frames rather than buffering them: a count is routing metadata;
the frames are the user's data. The relay only clears its routing entry and
sends `session.detach`, which is why the count has to be the daemon's. On refresh, the page re-attaches with the token and
hydrates history *from the agent side* (`history.request` → ACP `loadSession`
replay).

**Consequences.** A page refresh round-trips through the user's own machine to
restore the UI. The relay stores nothing readable even before ADR-003 sealing.

---

## ADR-006: Harvest WebMCP, and claim only what we harvest — accepted (claim rewritten 2026-08-07)

**Context.** WebMCP (`document.modelContext`, formerly `navigator.modelContext`)
is a Web Machine Learning Community Group **Draft Community Group Report** —
not a W3C Recommendation, not on the standards track, experimental in Chrome
only, WebKit opposed, Mozilla neutral, TAG review pending. It is still exactly
the input side we want: a site declaring what it can do, for whatever agent is
present. AgentPort supplies what that draft deliberately scopes out — identity
(AgentCert), transport, session scoping (grants + TTL), and consent — for an
agent the *user* owns, running elsewhere. That relationship is unchanged, and
NORTH-STAR is right that WebMCP is a component we harvest, never a competitor.

What changed is the claim. The first version of this ADR concluded **"every
WebMCP-adopting site becomes AgentPort-compatible with zero AgentPort code"**.
That was never true, and it did the specific damage a reassuring sentence does:
it read like a finished feature, so for five months nobody re-read the draft.
In that window `provideContext()` was removed (2026-03-05) and both harvesters
kept wrapping it; `registerTool()` became promise-returning (2026-06-08) and we
kept adopting tools the browser had refused; and the approval gate stayed keyed
on `annotations.destructiveHint`, an MCP field the current draft does not
define, so a spec-compliant `purchase` or `delete` tool arrived **ungated**.
`docs/reviews/webmcp-conformance.md` is the independent review that found it.

**Decision.** Keep harvesting. Withdraw the claim and replace it with one that
is concrete enough to be wrong.

*What a site can rely on today:*

1. Tools registered through `document.modelContext.registerTool(tool, options)`
   **after** AgentPort's script is present are harvested into the session
   grant, in both connect.js and the extension.
2. `navigator.modelContext` is probed as a fallback, so integrations written
   before the getter moved to `Document` (2026-05-27) still work.
3. The whole options object is forwarded to the native implementation
   untouched, so the site's own `signal`/`exposedTo` behave as the browser
   defines them.
4. A tool is adopted only once the native registration promise **fulfils**, so
   a registration the browser rejected is never lent to the agent.
5. Aborting the `AbortSignal` passed to `registerTool` withdraws the tool from
   the harvested set — the draft's only unregistration mechanism.
6. A page's `execute` return value is forwarded as a raw JavaScript value, as
   the draft specifies; the MCP envelope is built at the daemon.
7. On a browser with no WebMCP at all, the extension installs a stand-in shaped
   like the current draft — `EventTarget`, promise-returning `registerTool`,
   `getTools()`, `toolchange` — and offering none of the members the draft
   dropped.
8. **Every harvested tool requires per-call approval.** Nothing the page wrote
   about a tool changes that.

*Why (8) is unconditional.* Everything we know about a harvested tool was
authored by the page, and a page is untrusted here by standing rule; MCP says
the same of its own annotation hints. There is therefore no page-authored field
that may decide whether the user is asked — and "the page may add approval but
never remove it" is not the rule either, because the gate is a boolean whose
default is already the maximum, so there is nothing left for a page to add.
Name-sniffing is the same defect wearing a different field. The relaxation the
review suggests — `readOnlyHint === true` *and* a trusted user-side origin
policy — waits on the second half, which does not exist; shipping only the
first half would rebuild the identical hole under a new name.

*What we do not implement* is enumerated, in code, in
`WEBMCP_NOT_IMPLEMENTED` (`packages/client/src/webmcp.ts`): declarative WebMCP
(the draft marks its own section TODO), `executeTool()` (Chrome-only and ahead
of the CG IDL, and the draft does not give its signature), `getTools()` as a
source of lendable tools (`RegisteredTool` carries no callback, so tools
registered before we load are reported in a warning and lent to nobody),
`exposedTo`/`fromOrigins`/the `tools` Permissions Policy, per-tool owner origin
and window in the grant, `title` and `untrustedContentHint` in the grant (no
`ToolDefinition` field exists for them), live grant reconciliation (a grant is
a snapshot taken at attach time, so a withdrawal after attach leaves the
session's routes intact), and MCP-B `CallToolResult` normalisation.

*Where the belief lives.* `packages/client/src/webmcp.ts` is the single
artifact: the descriptor we accept, the options we forward, the shape we
produce, the gating rule, and the not-implemented list. Both harvesters are
wiring over it. An internal registry can be made compiler-exhaustive; someone
else's draft cannot, and "re-read the spec periodically" is a process, and
processes rot. One file is what is left: the next person diffs the draft
against it instead of auditing two harvesters that already drifted apart once.
`npm run webmcp:harvest` is its acceptance gate.

**Consequences.** The supportable claim is *"best-effort compatibility with
imperative WebMCP registrations, including older MCP-B/early-Chrome shapes"* —
not "full WebMCP conformance", which waits on a stable declarative spec,
representative WPT coverage, and browser-agent execution semantics.

Every harvested tool call now costs an approval round-trip — an extension
consent window per call in the widget tier, a terminal prompt in the drop-in
tier. That is a real cost and it is the right one: nobody described that
capability to the user, and the extension attached on their behalf without the
site being asked.

One thing this ADR does **not** fix, so it is written down rather than implied:
a tool passed explicitly through `connect()` is still ungated unless the site
sets `requiresApproval` or names it in `alwaysAsk`, and both of those are also
page-authored. The two cases are not identical — a `connect()` integration is
code the site wrote against us, and the consent screen shows the user the exact
partition of free vs. always-ask tools before they approve it — but the default
there is fail-open too. Closing it needs a user-side origin policy, which is
also the missing half of the `readOnlyHint` relaxation above. One mechanism
would answer both.

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
(`npx @gkoreli/agentport connect CODE`) belongs only to the keyless drop-in path.

**Decision.** Three coexisting tiers, each a superset of convenience:

1. **Drop-in code flow** (universal, zero install) — page shows a code, the
   owner claims it where the key lives. The stranger-machine fallback, forever.
2. **Extension wallet** (one-tap) — holds the user key and AgentCerts; pair
   once, then connect.js detects it and routes `session.open` + approvals
   through it. Picker → tap → session. No terminal, no codes.
3. **Hosted wallet popup** (Shop Pay tier) — browser-side memory with no
   install. **Shipped** (`wallet/`, `npm run wallet:build`) and now tried
   FIRST in `connect.ts`'s ladder when no extension is present — the
   deferral below was written before it existed.

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
3. **Revocation is CLI-only** — `agentport status | revoke <origin> |
   unpair` (ADR-022); no wallet or extension surface lists what holds your
   agent. (`CertStore` itself is gone: ADR-016 made the relay stateless.)
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
- **The name stays AgentPort.** The unscoped npm name belongs to an unrelated
  project, and the `agentport` organization scope is unavailable. The public
  CLI therefore ships as `@gkoreli/agentport`; the executable remains
  `agentport` once installed.

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

**Context.** AG-UI normalizes the agent→client edge: the events an agent
streams to a UI (text deltas, reasoning, tool-call lifecycle, run lifecycle)
and the streaming/run semantics around them, so an application builder can add
agentic flows to their own site without inventing that vocabulary. It solves
that problem well, and there is a real ecosystem of renderers (CopilotKit et
al.) on top of it.

What it does not do — and does not try to do — is bring-your-own-agent: it
assumes the application builder controls the agent. That assumption is the one
AgentPort removes. A user's own agent, owned by their key, consented per
session, reachable from any site, with the site learning nothing about runtime,
model, memory, or who pays for inference, is outside AG-UI's scope and always
was. So AG-UI is not something to measure ourselves against; it is a well-made
component we use, because event vocabulary and streaming semantics are exactly
the kind of thing you should not hand-roll when someone has already normalized
them.

**Decision.** Integrate as an ADAPTER at the client edge, not as the wire
format:

- Ship `@agentport/agui`: translate a live `AgentSession` into an AG-UI event
  stream (`delta` → TEXT_MESSAGE_CONTENT, `thought` → REASONING_*, `tool.call`
  → TOOL_CALL_START/ARGS/END plus TOOL_CALL_RESULT, `approval` → a CUSTOM
  observation). Any AG-UI-compatible component can then render an AgentPort
  session with zero custom code.
- The event types come from `@ag-ui/core` (pinned `^0.0.57`), not from a local
  restatement of them. That is what the first version got wrong: it declared
  the event shapes by hand, missed TOOL_CALL_RESULT entirely, and stuffed the
  tool's return value into `rawEvent` on TOOL_CALL_END — where no standard
  renderer looks. A standard renderer showed tool calls and never their
  results, so the "zero custom code" claim above was false from the day it was
  written. Depending on the package is safe here: it brings zod, which the
  bundle rules for `@agentport/protocol` and `@agentport/client` would forbid,
  but the dependency direction is agui → client and never the reverse, and
  `@agentport/agui` is consumed only by our own demo surfaces. It is not in
  connect.js, the drop-in that ships into other people's pages. Measured:
  +69 kB to inkwell.js and tasker.js, 0 to connect.js.
- Our SessionFrame vocabulary REMAINS the sealed wire format. Interop has no
  value inside ciphertext — only at the edges where other people's code runs —
  and the frames carry the things this project exists to get right: the
  ephemeral-key handshake, the capability grant, resume authority, and who is
  allowed to answer an approval.
- The earlier version of this record said to revisit AG-UI alignment "only if
  it clearly wins its layer; premature while the spec is young". That reasoning
  was backwards. A young, fast-moving spec is an argument FOR depending on the
  package: its versioning tells you when you have drifted. Restating it locally
  is how you drift silently. This repo has now been bitten twice — the
  hand-rolled AG-UI types above, and the WebMCP harvester, which by its own
  report "follows the repository's existing extension integration, not an
  independently fetched specification" — a quotation whose source is no
  longer in the tree, so read it as recorded history rather than a citation;
  `npm run webmcp:harvest` is the live check and writes no report. Take the dependency; pin it; let the
  package's own schemas fail the check when we drift (`npm run agui:check`
  parses every emitted event with `EventSchemas`).

**What the component offers that we have not taken.** Reading the package
rather than the event enum alone turned up more than the adapter uses. These
are not gaps in AgentPort; they are normalized pieces available to us if we
want them:

- `InterruptSchema` / `ResumeEntrySchema` / `RunFinishedInterruptOutcome`: a
  structured pause-and-answer mechanism, keyed to a `toolCallId`, with a
  declared `responseSchema` and an `expiresAt`.
- `HumanInTheLoopCapabilities` = `{supported, approvals, interventions,
  feedback, interrupts, approveWithEdits}`. `approveWithEdits` — approve a
  call but modify its arguments — is a good idea our approval round-trip does
  not have, and worth adding on its own merits.
- `ToolsCapabilities.clientProvided`, `TransportCapabilities.resumable` and
  `.websocket`: a way to declare, in someone else's vocabulary, things our
  transport already does.
- `ToolMessage` = `{id, content, role, toolCallId, error, encryptedValue}` —
  tool results as messages, with an error channel the event side lacks.
- In passing: `RunAgentInput` carries `{threadId, runId, state, messages,
  tools, context, resume}`. That is close to the shape of our own
  `session.open` grant, and `tools.clientProvided` names the same idea as a
  site lending its tools. Others hit the same shape; nothing more is claimed
  from it.

**Open question — NOT decided.** The adapter is one-way (agent → events).
`AbstractAgent` in `@ag-ui/client` (not a dependency of this repo) is a
subclassable agent abstraction (`runAgent`, `connect`, `abortRun`,
`addMessages`, `setState`, `subscribe`, middleware via `use`); `HttpAgent` is
only one transport implementation of it, and `connect` is part of the
abstraction, with `AGUIConnectNotImplementedError` for implementations that do
not offer it. Implementing `AbstractAgent` over the AgentPort sealed channel
would be an adoption lever, not an alignment exercise: anyone who has already
built a UI against AG-UI could swap in a user-owned agent with almost no work.
It would need `runAgent` mapped onto our prompt/session lifecycle, interrupts
mapped onto `approval.request`/`approval.response` (with authority staying at
the user's wallet or daemon — never the page), and an `AgentCapabilities`
declaration. Nobody has decided to do this. Do not implement it on the strength
of this paragraph.

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

**Who is shown the fingerprint words follows who holds the ephemeral secret**,
and the answer differs by tier — so this is stated once rather than left to be
rediscovered. Words are only meaningful to a party that is actually an endpoint
of the key exchange:

- **Drop-in (connect.js, no extension).** The page mints the ephemeral keypair
  and IS the client endpoint, so the page is one of the two consent surfaces
  and MUST render `session.info.verify`. This is the entire MITM check that
  tier has.
- **Extension-mediated.** The extension is the endpoint and the page is not.
  The page is told the session reattached — its in-flight prompt died and it
  must re-read history — but never receives the words, which would verify
  nothing for it and would supply the text needed to paint convincing fake
  chrome. Same reasoning that already redacts the agent's real name toward a
  page.

The rule is therefore "words go to whoever holds the epk", never "pages do not
get words". Unifying these two tiers in either direction silently breaks one of
them: giving them to a mediated page hands a site free spoofing material, and
withholding them from a drop-in page deletes that tier's only MITM check.

A rekey changes the words. Any surface that shows them must show the CURRENT
ones — a resume or reconnect mints fresh ephemeral keys, and a stale string
left on screen is worse than none, because it invites a comparison that cannot
succeed.

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
- the resume bearer token while a resume/open response is in transit;
- the origin carried by a `revoke` frame — so a relay that routes one learns
  which site you just cut off from this agent, and by accumulation which sites
  you have attached to through it. ADR-022 R8 considered hashing the origin
  and rejected it as theatre: origins are low-entropy and the relay already
  knows the agent key, so any hash it can see it can also brute-force.

These fields are authenticated where they affect the session decision, but
they are not confidential. The relay stores none of them durably; seeing a
resume token in transit is different from minting, judging, or retaining it.
The daemon owns resume authority and rejects token guessing with a bounded
attempt count, constant-time comparison, and a generic unprovable-session
response. Because the relay sees a valid token, resume additionally requires
an EPK proof by the Ed25519 client identity captured at open. That stored
identity is immutable: a resumer cannot replace it.

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
  surface selector, bounded attachment identity, and resume token required to
  reattach. The attachment identity is not the user root and lives beside the
  capability only in per-tab storage. The extension also
  records the origin/name lookup key and grant expiry in extension-only session
  storage. A resume token is a bearer secret scoped to its existing session
  and still bounded by the original grant and expiry.
- X25519 sealing keys live only in endpoint memory and are replaced on every
  resume. A resumable page attachment's bounded Ed25519 identity lives beside
  its token until the tab/session ends. JavaScript cannot guarantee physical
  zeroization; the design therefore relies on scoped authority and bounded
  persistence.

### Fail-closed rules

- Invalid certs, identity signatures, peer ownership, or session membership
  are rejected.
- Missing/invalid ephemeral keys or proofs abort open/resume.
- Plaintext content frames are dropped; content is never retried unsealed.
- AEAD failure, counter mismatch, or forbidden inner frame type is dropped
  without advancing receive state.
- Expired grants or delegations, unknown tools, declined approval, invalid
  resume authority or identity, and attempts to replace a live attachment are
  denied.
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
| Resume preserves identity and authority while rekeying | daemon-owned token/client/grant/delegation state; fresh endpoint epks | malicious-relay token theft after forced detach, legitimate same-identity recovery, authorization expiry, live-session replacement, and rekey checks |
| Conversation remains at the edge | daemon/runtime history; relay count-and-drop behavior | refresh replay proves history came from agent side |

`npm run e2e` is the minimum acceptance test for these invariants, alongside
the TypeScript builds for protocol, browser, Worker, and examples. A test whose
assertion cannot fail for the claimed property does not count as evidence.

### Known blocking gaps

- ~~`decodeFrame()` validates only JSON, an object envelope, and a string
  `t`.~~ **Closed by ADR-019 §1.** It is now a six-stage pipeline — byte cap,
  raw depth scan, parse, canonical-form check, exact-`t` registry, strict
  schema — with the frame schemas as the single source of truth and the
  TypeScript types inferred from them.
- The E2E suite covers ownership denial, grant restriction, approval refusal,
  on-path observation, tampering, replay, proof stripping, grant rewriting,
  identity-bound resume-token theft after forced detach, and edge-owned
  history. It does not yet directly attack invalid cert rebinding,
  self-reported identity replacement outside resume, grant expiry outside the
  resume boundary, or
  every cross-role/non-participant route. Those rows above remain required
  test work, not implied coverage. (Old and resumed attachment keys *are* now
  compared — e2e asserts the fingerprint words change across a rekey, since
  identical words would mean a key was reused.)
- Production key custody and origin attestation still depend on completing the
  extension boundary. The in-page wallet remains demo-only.
- Revocation is CLI-only (`agentport status | revoke <origin> | unpair`, per
  ADR-022); no wallet or extension surface lists what holds your agent. Prompt
  injection containment for the runtime's unrelated personal tools remains
  incomplete (ADR-014).

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

---

## ADR-020: One chat renderer, with an extension-origin frame for injected UI — accepted

**Context.** Inkwell and the Chrome extension had independently implemented
the same transcript, composer, streaming, tool, queue, and cancellation UI.
The duplicate renderer had already drifted. The replacement chat set in
`src/nisli-ui` is deliberately protocol-neutral, but Nisli components are Web
Components and therefore need a custom-element registry in the JavaScript
realm that constructs them.

Scoped custom-element registries initially appeared to make those components
safe inside an isolated content script: Chromium 146 added constructable
registries, registry-scoped shadow roots, and registry-selected element
creation. A real unpacked-extension test on Chrome for Testing 151 disproved
that design. The isolated-world component was registered, but construction
failed with `Failed to construct 'HTMLElement': Illegal constructor`.
Chromium also explicitly prevents registry objects from crossing extension
world IDs because constructors and `whenDefined()` promises would otherwise
leak executable objects between worlds.

Lit is relevant prior art but does not remove that browser boundary. Lit's
renderer accepts a destination `creationScope`, and its Labs scoped-registry
mixin passes a shadow render root into template cloning. That mixin still
targets the earlier speculative API/polyfill (`customElements` and
`ShadowRoot.importNode`), is marked experimental, and assumes the component
constructor can execute in the render realm. It helps explain how a renderer
propagates registry ownership; it does not make an isolated extension world an
extension-owned component realm.

**Decision.** There is one semantic chat renderer: the Nisli `Chat` component
tree and `createChatStore()` in `src/nisli-ui`. Inkwell mounts it in the site
document. The extension mounts the identical source in an extension-origin
iframe, where the document, JavaScript realm, and global custom-element
registry belong to the extension.

The isolated content script remains the mediator. It creates only ordinary DOM:
a host, a closed shadow root, and the iframe. The closed root prevents page code
from obtaining the live iframe window; it is not treated as proof of UI
authenticity or availability. A private transferred `MessagePort` carries a
narrow semantic command/action vocabulary between mediator and renderer. The
page never receives that port, session references, grants, approvals, resume
authority, or raw worker frames.

The content script owns session state, page tools, worker communication, prompt
IDs, and cancellation. The iframe owns presentation state only. It may request
`attach`, `detach`, `prompt`, `cancel`, or one of the fixed compact/panel
layouts. The mediator may send phase/name changes, notices, user content, and
protocol-neutral `ChatUpdate`s. Unknown or malformed actions are ignored.

Consent and approval remain in extension chrome. An in-page surface can always
be removed, covered, or imitated by the page, regardless of shadow mode or
iframe origin, so it must never become an authority surface.

**Alternatives.** Keeping a second template-only chat was rejected because it
duplicates behavior and accessibility work. Running components in the content
script with the global registry was rejected because the page owns the tag
namespace and Chromium does not expose the main-world registry to an isolated
world. A fresh scoped registry was rejected for this surface because the real
browser construction path fails across the isolated-world/DOM realm boundary.
Running the component bundle in the page's main world was rejected because page
code could replace APIs and observe or alter application objects. A second
renderer library such as Lit was rejected because it adds a runtime without
changing any of those realm constraints.

**Consequences.** Both surfaces now share component behavior and semantic
updates while retaining different outer shells and trust boundaries. The
extension pays for one small extension document and a typed message adapter.
The page can deny availability by removing the host, which closes the widget
session; it cannot reach the extension iframe DOM or turn transcript controls
into consent. There is no legacy renderer and no protocol name in component
APIs.

**Implementation evidence.** Unit/type checks cover the semantic chat store and
both consumers. The extension build must additionally be loaded as an unpacked
extension in real Chrome, open the widget, and prove that the rendered tree
contains the shared `ui-chat`/`data-slot` contract without isolated-world
constructor exceptions.

**Authoritative prior art and platform references.**

- [HTML Standard: custom elements and registry association](https://html.spec.whatwg.org/multipage/custom-elements.html)
- [Chrome: scoped custom-element registries](https://developer.chrome.com/blog/scoped-registries)
- [Chrome Extensions: content scripts and isolated worlds](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chromium: cross-world scoped-registry isolation fix](https://chromium.googlesource.com/chromium/src/+/40b2818870e8acc4d968e4ea966decc9b5c8c020%5E%21/)
- [Lit Labs scoped-registry mixin source](https://github.com/lit/lit/blob/main/packages/labs/scoped-registry-mixin/src/scoped-registry-mixin.ts)
- [lit-html `creationScope` implementation](https://github.com/lit/lit/blob/main/packages/lit-html/src/lit-html.ts)

---

## ADR-021: The web harness — your own agent drives any website — proposed

Full record: [`ADR-021-web-harness.md`](ADR-021-web-harness.md).

The extension already lends generic page tools to the user's agent on sites
that declared nothing (`packages/extension/src/pagetools.ts`), through the same
grant, consent, and sealing path as a declared surface. That is not a fallback
— it is the widest form of the product, and the one thing a browser vendor's
built-in assistant cannot copy: it is the *same agent* the user already runs,
with their memory, prompts, MCP servers, and files.

Two things block it, both found by using it. A navigation kills the session —
deliberately, in `packages/extension/src/sw.ts`, where only `from === 'page'`
surfaces get orphan-and-reclaim — so the one surface built for multi-page flows
cannot survive succeeding at a click. And every gated call re-asks, because
nothing remembers a decision, which on a generic harness means a dialog every
few seconds and a user trained to approve without reading.

The decision: **the attachment belongs to the user and the origin, not to the
document.** Sessions survive same-origin navigation and detach across origins;
navigation becomes a real tool rather than something that happens to the agent;
consent is remembered per origin and per action class, expiring and revocable,
never a blanket allow-all; site-declared tools win where they overlap with
synthesized ones.

The consent half of that was then rejected by an independent security review
(`docs/reviews/web-harness-consent.md`) and the record rewritten. Remembering
approval "per action class" is unsound however it is scoped: `click` is not a
security class (one click can purchase, publish, authorize or delete), and
`fill` is not a step before data egress but data egress itself — it dispatches
`input`/`change` events the page's own scripts observe, so an "ask before
Submit" policy never fires. The corrected model remembers **attaching and
reading**, never mutating; every generic fill, click, submit and navigation
keeps an explicit approval.

The review also found a defect this proposal would have made dangerous: gated
page calls and the runtime's OWN tool-permission requests share one untyped
boolean decider with no provenance field, so a remembered page policy could
satisfy an approval that was never about the page. Approvals need an
extension-trusted authority domain before anything can be remembered at all.

---

## ADR-022: Revocation — taking it back — accepted (shipped 2026-08-06)

Full record: [`ADR-022-revocation.md`](ADR-022-revocation.md).

The north star's fourth requirement is that ownership be provable *and
revocable*. The first half was built; the second was a named blocking gap in
ADR-018 and an open problem in ADR-014. Three documents asked for it in three
different shapes — Gate B §5 at the agent level, the consent review at the
origin level, the prior-art synthesis first in the build order — and the word
"revoke" was doing four jobs with four blast radii.

The decision: **the revocation object is the `SessionDelegation`, addressed by
its origin**, because that is the only protocol object carrying website-scoped
authority. A revocation is a **tombstone, not a denylist** — `{origin, at}`
refuses every delegation that origin holds which was issued at or before `at`,
and admits one issued after. Withdrawing is complete; approving again needs no
un-revoke verb; and because a delegation's lifetime is now bounded
(`MAX_DELEGATION_LIFETIME_MS`, with `issuedAt` mandatory and signed), a
tombstone can be dropped once nothing it could refuse is still alive. The
store is finite by construction rather than by a cap.

Two things that landed the same day changed what it had to mean. Automatic
client redial (`c522087`) means a closed socket is something the client heals
from, so revocation makes a session **unresumable at the daemon**, and the
acceptance check drives the reconnect path rather than the socket. And the
grant-binding fix means the delegation now commits to the grant, so retaining
it on the session is what lets a resume — which presents a token and proof by
the original bounded attachment identity, but not the delegation again — be
re-judged against expiry and an origin the user has since cut off.

Two defects were closed on the way, both found by mapping the design onto real
code. Absent ownership was **permission**, not refusal: `cert && client !==
cert.user` meant an unbound daemon accepted whoever the relay stamped, so
`unpair` would have opened the daemon rather than closed it. And a
`pair.bound` was accepted unconditionally, so anything that could make the
daemon begin pairing — its own control file, reachable by the uncontained
agent runtime — could replace a live owner's cert with its own. Reverting that
guard makes the e2e check report "the thief owns it now".

What it does not do: no remembered-consent policy store, no audit view, no
per-action-class revocation (all the extension's lane); no multi-relay fan-out
(a cert names no relay); and no containment of the local CLI seam, which stays
reachable by anything running as the user until Gate C. Nothing reachable
there grants — every verb only narrows what the agent accepts.

---

## ADR-023: An approval says what it is for — accepted (shipped 2026-08-06)

Full record: [`ADR-023-approval-authority.md`](ADR-023-approval-authority.md).

The consent review found that gated site-tool calls and the runtime's own
tool-permission requests reach the same untyped boolean decider with nothing
distinguishing them. True, and the interesting part is not the one it names.
The attack is not auto-approval — the extension never branches on the tool
name and always asks a human. The attack is that the consent window renders
the summary the request carried, and the runtime's own requests carry
agent-chosen text steered by page content. So an own-tool request can be made
to read exactly like a granted site tool, **inside the one window a page
cannot forge**, above the arguments of what is actually the agent's own shell.
It does not bypass the decider; it asks the human a question that
misrepresents what they are approving, in the surface whose whole value is
that it cannot be faked.

So the authority domain is not an input to a future policy engine — it is a
thing every consent surface must *say*, before anything the agent wrote. The
daemon stamps it and the runtime gets no parameter: `TurnContext`'s
`requestApproval` is the only path a runtime can reach, so everything arriving
there is its own capability by construction, and a parameter would have made
it a self-declared field. The set is closed at three (`generic_page_tool`
joined in wire v4, for tools the EXTENSION synthesised over a page that
declared none), and the sizing rule is the
rendering rule — a member that cannot be explained to a user in one clause is
probably two domains.

`ApprovalResponse` also now carries a digest of the call, recomputed by the
responder from what it was shown rather than echoed. Not for today's code,
where a fresh correlation id and a human at the keyboard nearly suffice, but
for the answer nobody looks at: the moment a policy engine or a remembered
decision can produce a "yes" — which is what ADR-021 wants — that yes must be
pinned to the call it was made about, or a stored approval for one call
satisfies another.

Two defects closed on the way, both about the failure path rather than the
happy one. A human title was being written into a `TOOL_NAME_PATTERN` field,
so a title with a forbidden character rejected the whole frame and the user
was never asked. And a throw inside an `.onRequest` handler never reaches the
wire, so the agent waited for a permission response that would never come:
loud at the sender is silent on the wire, and the wire is where the peer is
waiting. Internal failure is now a denial with a logged reason.

R9 records one property this change does *not* assert — that a replayed
`approval.response` is ignored — with the reason it could not be tested
honestly, rather than shipping a check that would pass either way.

---

## ADR-024: The agent may ask its own user — accepted (shipped 2026-08-07)

Full record: [`ADR-024-elicitation.md`](ADR-024-elicitation.md).

`AskUserQuestion` was **actively disabled** in every AgentPort session — the
daemon declared no elicitation capability, so `claude-agent-acp` put that tool
on its own disallowed list. The agent could not ask its user anything, so it
guessed, and never reported that it could not ask. An AgentPort session was
quietly worse than using the agent directly, which is the one thing the north
star cannot afford.

The design is entirely about **where an answer may come from**. An elicitation
answer is the only page-reachable channel that would carry *user authority*
into the agent's reasoning — every other one is already classified hostile —
so a page supplying it is privilege escalation in the trust model rather than
impersonation within it. And it cannot be softened: bounding the answer space
bounds *what* is said and does nothing about *who is recorded as saying it*,
and attribution to the user is not a side effect of the feature, it is the
feature.

So the rule is about routing rather than tiers: **an elicitation may only be
answered on a surface the requesting origin cannot draw, read, or forge.**
Refusal is by per-attachment capability negotiation, not by rejecting
requests — a refused tier's agent has no ask affordance at all, so the refusal
path has no code and therefore cannot hang.

Two things the record deliberately does *not* claim. It does not make the
agent *know* it may not ask — a model experiences an absent tool as nothing at
all — so visibility is a separate, user-facing win (R3/R4). And R10/R11 record
a hole this exposed rather than fixing it: page-answered `runtime_own_tool`
approvals are wrong for the same reason, the wallet-origin redirect that
looked like the fix cannot work (a popup needs user activation an
agent-initiated approval does not have), and the answer is the same refusal.
