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

1. **The relay cannot forge a binding.** `CertStore.put` refuses certs that
   fail `verifyCert`. The relay only ever stores what a user signed.
2. **The grant is the boundary.** `AgentDaemon#callTool` rejects any tool not
   in the session's grant and any call after `grant.expiresAt`. Enforced again
   on the client, which only dispatches tools it registered.
3. **The relay stamps identity.** `session.open` forwards `client: <pubkey>`
   from the authenticated socket. Never trust a self-reported identity in a
   frame.
4. **Only participants may speak.** Routing checks session membership *and*
   `mayOriginate(role, type)`, so a client cannot fake a `tool.call` and an
   agent cannot fake an `approval.response`.
5. **You can only reach agents you own.** `session.open` requires a stored cert
   whose `user` equals the connecting client's key.
6. **Keys never cross the wire.** Only public keys, signatures, and certs.

Every one of these has a check in `scripts/e2e.ts`. If you change routing or
auth, add one.

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
`AGENTPORT_NAME`, `AGENTPORT_LOCATION`, `AGENTPORT_RELAY_STORE`.

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
2. **End-to-end encryption.** The relay currently reads session frames. It
   should only see routing metadata. Seal frame bodies to the peer's key.
3. **Extension packaging.** The wallet lives in the page today, which is only
   acceptable for a demo — the page can reach the user key. Move it behind an
   extension boundary with `postMessage`.
4. **WebMCP interop.** Consume `navigator.modelContext` tool registrations as
   `SiteTool`s so sites get AgentPort for free once they support WebMCP.
5. **Revocation UI.** `CertStore.remove` exists; nothing calls it.
6. **Reconnect + session resume.** Sockets are assumed stable; they aren't.

## Transport, and why not Tailscale

Both legs are `wss://` — browser→relay and daemon→relay — so everything is
TLS-encrypted in transit, and the daemon dials OUT (no inbound port, no
firewall rule, nothing listening on the user's machine).

The relay terminates TLS, which means **it can currently read session frames**.
That is the one unresolved privacy gap in the system; see the E2E encryption
item below. Ownership certs and public keys are all it is supposed to hold.

Tailscale would not help here and is deliberately not used: a website running
in someone's browser cannot join a tailnet, and the whole point is that any
site can attach. For the paranoid case the answer is not a VPN but
self-hosting — `AGENTPORT_RELAY=wss://your-own-host/relay` runs the identical
`RelayCore`, so no third party is in the path at all.

**Planned:** seal frame bodies to the peer's key (X25519 + AEAD), leaving only
`t` and `s` readable by the relay. Both ends already have Ed25519 identities;
the relay would hand each side the other's public key at session open. After
that the relay is a dumb pipe by construction rather than by policy.

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
| ownership certs | the relay, and the wallet | relay sees public keys only |
| conversation frames | in flight only | relay forwards, never stores |

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
