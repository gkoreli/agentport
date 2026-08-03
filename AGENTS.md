# AgentPort — working notes for agents

## What this is

`navigator.agent` — the missing primitive that lets a user bring **their own
running agent** to any website.

NIP-07 gave sites `window.nostr`: *"here is my identity, sign this."* AgentPort
is the same shape for agents: *"here are my tools, run them on my behalf."* The
site never learns which runtime, which model, whose memory, or who pays for
inference. The agent stays on the user's own machine.

Inverted from everything adjacent: MCP/WebMCP let a **site or tool** expose
capabilities to whatever agent the platform supplies. AgentPort lets the
**user** supply the agent, and the site lends it capabilities for one session.

## Non-goals

- Not an inference router. We never see a model or an API key.
- Not an agent framework. Runtimes are pluggable; we don't own the loop.
- Not a workspace. The agent isn't a member of anything — it's attached and
  then detached.
- Not a new tool-description format. Long term the site's tools should come
  from WebMCP (`navigator.modelContext`); `SiteTool` is shaped to match.

## Architecture

```
[SITE]   Inkwell page — declares tools, calls navigator.agent.connect()
   |     never sees keys, models, or the agent's own tools
   v
[WALLET] @agentport/client — user key custody, agent picker, consent,
   |     approvals. Ships as a browser extension; in the demo it is in-page.
   v
[RELAY]  @agentport/relay — pairing, presence, directory, opaque forwarding.
   |     Holds certs and nothing else. Cannot mint certs.
   v
[AGENT]  @agentport/daemon — on the user's VPS. Device key, session policy,
         runtime adapter (Claude Code / goose / codex / anything).
```

Three keys, three jobs:

| key | lives | proves |
|---|---|---|
| user key | wallet (extension / passkey / NIP-46 bunker) | "this is Goga" |
| agent device key | the VPS, never leaves | "this is Goga's VPS Agent" |
| session | ephemeral, per attachment | "this surface may use these tools until T" |

An `AgentCert` is the user key signing `{user, agent, name, runtime, location,
issuedAt}`. That is the whole ownership model.

## Layout

```
packages/protocol/   wire types, Ed25519 helpers, canonical JSON. No I/O.
packages/relay/      WebSocket relay + cert store. Node only.
packages/daemon/     VPS-side agent host + AgentRuntime interface.
packages/client/     wallet, session, navigator.agent provider. Isomorphic.
site/                the deployed demo: landing + two surfaces + CF Worker/DO.
examples/inkwell/    the original local-only demo, kept as the minimal example.
scripts/e2e.ts       the real test — relay + daemon + wallet over real sockets.
scripts/acp-smoke.ts real-agent proof; run where the ACP agent is authed.
scripts/remote-check.ts  pair + prompt against the deployed relay.
```

Deployed at https://agentport.gogakoreli.workers.dev — one Worker serves the
static surfaces and routes `/relay` to a Durable Object wrapping `RelayCore`.
`run_worker_first = ["/relay"]` in wrangler.toml is load-bearing: the asset
router 404s unknown paths before the Worker ever sees the upgrade.

## Invariants — do not regress these

ADR-018 is the authoritative security architecture and threat model. This
section is the short implementation checklist, not a second protocol spec.

1. **The relay cannot forge a binding — and stores nothing** (ADR-016). Certs
   are verified when a connection presents them and live only as long as the
   socket. The durable copies are at the edges: the daemon's identity file and
   the wallet's own store.
2. **The grant is the boundary.** `AgentDaemon#callTool` rejects any tool not
   in the session's grant and any call after `grant.expiresAt`. Enforced again
   on the client, which only dispatches tools it registered.
3. **The relay stamps identity.** `session.open` forwards `client: <pubkey>`
   from the authenticated socket. Never trust a self-reported identity in a
   frame.
4. **Only participants may speak.** Routing checks session membership *and*
   `mayOriginate(role, type)`, so a client cannot fake a `tool.call` and an
   agent cannot fake an `approval.response`.
5. **You can only reach agents you own.** The relay checks the live
   connection's presented cert against the opener's stamped key, and the
   daemon re-checks `client === cert.user` itself — the invariant holds even
   against a lying relay.
6. **Secret keys never cross the wire.** Only public keys, signatures, and
   certs identify endpoints; attachment secrets remain in endpoint memory.

These are mandatory acceptance properties. ADR-018 maps them to current
evidence and names the remaining blocking coverage gaps. If you change routing
or auth, add the adversarial check in the same change.

## Running it

Three terminals:

```bash
npm run relay     # ws://127.0.0.1:8787
npm run daemon    # prints a pairing link + code
npm run demo      # http://127.0.0.1:8788
```

Open the demo, hit **Pair a new agent**, paste the code, then **Connect
agent**. The daemon's pairing link (`/pair#code=…`) auto-fills the dialog.

```bash
npm run e2e        # full loop, no browser, ~1s, 18 checks
npm run typecheck  # tsc -b over all packages
npm run deploy     # build the site + wrangler deploy

# these three are checked separately, outside the project references
npx tsc -p examples/inkwell/tsconfig.json
npx tsc -p site/tsconfig.json          # browser code (DOM lib)
npx tsc -p site/tsconfig.worker.json   # worker code (workers-types)
```

Browser and Worker type-check separately on purpose: `@cloudflare/workers-types`
and the DOM lib define conflicting globals, so mixing them in one project
produces nonsense errors.

Env: `AGENTPORT_RELAY`, `AGENTPORT_IDENTITY`, `AGENTPORT_RUNTIME`,
`AGENTPORT_NAME`, `AGENTPORT_LOCATION`.

## UI framework

Everything user-facing is built with **nisli** (`@nisli/core`, Goga's own
signals + `html` template + custom-element framework; local checkout at
`/Users/goga/Documents/goga/nisli`). No VDOM, no compiler, no runtime deps —
which matters most for `connect.js`, since that ships into other people's
pages.

One deliberate split, in both the extension and the site:

- **Our own pages** use `component()`. Idiomatic, and registry collisions are
  not a threat on a page we control.
- **Anything injected into a third-party page** — the connect modal, the
  extension overlay — uses the `html` template layer only, never
  `component()`. A custom-element tag name lives in a registry the embedding
  page can also reach, and a tag it could pre-empt is a tag that could
  impersonate a consent dialog. The template layer owns its DOM outright, so
  the trust story doesn't depend on registry isolation.

`scripts/ui-smoke.ts` renders both under happy-dom and asserts the shadow root
stays unreachable via `.shadowRoot`.

The agent panel's transcript is the protocol-neutral Nisli chat set in
`src/nisli-ui/ui/chat`, backed by the semantic store in
`src/nisli-ui/lib/chat.ts`. Protocol names do not belong in this component API:

- **`applyEvent()` in `site/src/agentport-ui.ts` is the boundary.** The page
  consumes `@agentport/agui` and translates its events into semantic chat
  updates (`message.*`, `reasoning.*`, `tool.*`, `run.*`). A richer transport
  event should land in that adapter, not in protocol-specific rendering code.
- **Styling is the `data-slot` contract, not Tailwind.** The copied components
  carry utility class lists this site deliberately does not build; the chat
  section of `site/public/styles.css` styles semantic `[data-slot]` selectors
  in the site's own palette. Do not add a Tailwind pipeline for this.
- The chat composes Nisli's generic `message`, `bubble`, `button`, and
  `message-scroller` primitives. Extend those primitives instead of creating a
  second implementation of scrolling, message layout, or buttons inside the
  chat set.

## Tenets

- **No legacy, no parallel paths.** When new code replaces an approach, the
  old path is deleted IN THE SAME CHANGE — never deprecated, never kept
  "just in case", never left as a second way to do the same thing. If a
  fallback must exist (e.g. the connect-code flow beside one-tap), it is a
  *documented tier* with its own reason to live, not leftovers. A PR that
  adds an abstraction and keeps the hand-rolled version alongside is
  incomplete. Corollary: new abstractions must be consumed by our own code
  immediately (dogfooding) — an adapter nobody calls is decoration.
- **Production grade or not at all.** No silent failures, no swallowed
  errors, no vacuous tests (a test whose assertions cannot fail proves
  nothing), no security by assertion — invariants get checks in e2e.

## Conventions

- ESM everywhere, `.js` extensions in relative imports (TS `Bundler`
  resolution, `verbatimModuleSyntax`).
- Workspace packages point `main` at `src/*.ts`; consumers bundle or run via
  `tsx`. No build step needed for development.
- `strict` + `noUncheckedIndexedAccess` are on. Keep them on.
- No dependency may be added to `@agentport/protocol` or `@agentport/client`
  that assumes Node. Both must run in a browser.
- Comments explain *why* a boundary exists, not what a line does.

## State of things

Working: pairing, cert issuance and verification, directory + presence,
capability grants with TTL, prompt streaming, tool-call round-trip, approval
round-trip, cancellation, session teardown, and the full demo UI. 18 e2e checks
pass.

Not built yet, in rough priority order:

1. ~~Real runtime adapter.~~ **Done.** `AcpRuntime` makes the daemon an ACP
   *client*, so any ACP agent can be the brain — Claude Code via
   `@agentclientprotocol/claude-agent-acp`, and goose/codex/gemini by changing
   two env vars. The session's grant is injected as a token-scoped,
   loopback-only MCP server (`McpBridge`) passed in `session/new`'s
   `mcpServers[]`, and withdrawn when the session closes. Verified end to end
   on `ssh vps` (ggsCloud) — see `scripts/acp-smoke.ts`.
2. ~~End-to-end encryption.~~ **Done.** See "Transport" below — X25519 +
   HKDF + XChaCha20-Poly1305, ephemeral per attachment, fingerprint words on
   both consent surfaces, on-path-observer test in e2e section 10.
3. **Extension packaging.** The wallet lives in the page today, which is only
   acceptable for a demo — the page can reach the user key. Move it behind an
   extension boundary with `postMessage`.
4. ~~WebMCP interop.~~ **Done.** Both connect.js and the extension harvest
   `document.modelContext` registrations (with the deprecated
   `navigator.modelContext` fallback) into `SiteTool`s at attachment time.
5. **Revocation UI.** `CertStore.remove` exists; nothing calls it.
6. **Reconnect + session resume.** Sockets are assumed stable; they aren't.

## Transport, and why not Tailscale

Both legs are `wss://` — browser→relay and daemon→relay — so everything is
TLS-encrypted in transit, and the daemon dials OUT (no inbound port, no
firewall rule, nothing listening on the user's machine).

The relay terminates TLS, so TLS alone would let it read session content.
ADR-003 closes that gap by sealing content between the browser and daemon;
ADR-018 records the complete security model and the lifecycle metadata that
remains visible.

Tailscale would not help here and is deliberately not used: a website running
in someone's browser cannot join a tailnet, and the whole point is that any
site can attach. For the paranoid case the answer is not a VPN but
self-hosting — `AGENTPORT_RELAY=wss://your-own-host/relay` runs the identical
`RelayCore`, so no third party is in the path at all.

**Shipped (ADR-003):** session content is sealed end-to-end. Each attachment
mints an ephemeral X25519 keypair, proves it with an Ed25519 signature from its
identity key (`epk`/`epkSig` on session.open/opened/resume, scope-bound so
proofs cannot be replayed across sessions), derives a key via HKDF-SHA256, and
every content frame crosses the relay as `{t:'enc', s, n, c}` under
XChaCha20-Poly1305. The relay cannot see content or its inner frame type.
Lifecycle frames remain clear: notably surface metadata, the capability grant
(including tool names), public identities and keys, agent/runtime labels, and
resume authority in transit. Resume uses endpoint-generated fresh keys carried
by `session.resume`/`session.resumed`; the relay only forwards them.

Because the relay can no longer see inner frame types, its per-type
`mayOriginate` check applies only to lifecycle frames; for sealed content the
same rule is enforced at the endpoints (`CLIENT_SEALABLE` in the daemon,
`AGENT_SEALABLE` in the wallet). The relay keeps its structural checks: only
stamped participants may speak, sessions only open toward owned agents.

Drop-in first contact is TOFU (the page's identity is itself ephemeral), so
both consent surfaces show six **fingerprint words** derived from the two
epks — the daemon consent screen and the page (`session.info.verify`). A match
means no relay sat in the key exchange. e2e section 10 proves the property
with a literal on-path observer: a recording proxy between wallet and relay
sees ciphertext only.

## Always-on agents

`deploy/agentport.service` runs the daemon under systemd. Paired with a wallet
that remembers agents, the browser flow becomes: open site → Connect → pick
your agent → approve in the browser. No terminal, no VPS access.

The terminal step in the drop-in flow is not inherent to the design — it is
what happens when the page has no wallet and therefore nobody to ask.

## Provenance — where the user's data lives

One rule: **conversation belongs to the user's own machine.**

| what | where | who can read it |
|---|---|---|
| transcript | the agent's own session store (Claude Code's, on the user's disk) | the user |
| resume token | sessionStorage on the site origin, per tab | that tab |
| ownership certs | the wallet and the daemon's identity file | relay verifies per connection, stores nothing |
| resume authority | the daemon (it mints and judges the token) | relay routes resume frames, holds no tokens |
| conversation frames | in flight only, sealed | relay forwards ciphertext, never stores |

The site keeps **no** transcript across a reload — not in localStorage, not in
sessionStorage. On resume the panel asks the agent for the history via
`history.request`, and the daemon answers by calling ACP `loadSession`, which
replays from the agent's own store. `claude-agent-acp` advertises
`loadSession: true` (verified), so this is the same history the user sees in
their own client.

The daemon keeps an in-memory transcript too, but only as a fallback for
runtimes that persist nothing — `replayHistory()` on the runtime wins whenever
it returns non-null.

The relay holds sessions open for `ORPHAN_GRACE_MS` after a client drops so a
refresh can re-attach, but it does **not** buffer the agent output that
arrives meanwhile — it counts the frames and drops them. A count is routing
metadata; the frames are the user's data. An earlier version of this buffered
500 frames in the Durable Object; that was a privacy regression and was
removed.

## Prompt injection

Document text flows into an agent that holds tools over that same document.
Treat every tool result as hostile data, never as instruction. The approval
round-trip is the only thing standing between a poisoned paragraph and a
destructive write — do not add tool paths that bypass it, and do not let a
runtime auto-approve on the daemon side.
