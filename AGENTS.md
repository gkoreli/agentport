# AgentPort — working notes for agents

## What this is

> The north star — what this is for, how the neighbouring protocols relate, and
> what we will never be — is `docs/NORTH-STAR.md`. Read it before proposing
> architecture.

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
  from WebMCP (`document.modelContext`); `SiteTool` is shaped to match.

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
CHANGELOG.md         what changed per version, and why it mattered.
docs/NORTH-STAR.md   what this is for; read before proposing architecture.
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
   `mayOriginate(role, type)`. On the socket that admits only lifecycle frames
   plus `enc`; the per-direction content rule lives inside `openSealed`, which
   the relay cannot apply because it sees ciphertext.
5. **Nothing reaches a handler unvalidated** (ADR-019 §1). `decodeFrame` is the
   only way a frame becomes typed: byte cap → raw depth scan → parse →
   canonical-form check → exact-`t` registry → strict schema. `openSealed`
   applies the same decoder to decrypted plaintext. Frame schemas in
   `messages.ts` are the single source of truth — the TypeScript types are
   inferred from them, so a validator and its type cannot drift.
6. **You can only reach agents you own.** The relay checks the live
   connection's presented cert against the opener's stamped key, and the
   daemon re-checks `client === cert.user` itself — the invariant holds even
   against a lying relay.
7. **Secret keys never cross the wire.** Only public keys, signatures, and
   certs identify endpoints; attachment secrets remain in endpoint memory.
8. **A page may answer for its own capability, never for the user's, and
   never as the user** (ADR-024 R11). A `site_tool` approval is the page's own
   function, so a site forging one gains nothing it did not already have —
   self-referential, not escalation. A `runtime_own_tool` approval is the
   user's machine, and a page that does **not** hold the user key answering
   for it *is* escalation. So `#hasTrustedAnswerSurface` keys on delegation:
   a **delegated** attachment is refused outright — never rerouted, because
   the wallet popup needs a user gesture the agent does not have and an iframe
   the page can cover is not a consent surface — while `viaConnect` (the
   daemon's terminal) and direct-key (the wallet holds the user key) are
   asked. The refusal is stated to the page in
   `session.opened`/`session.resumed` and rendered, so the user is told rather
   than quietly given a diminished agent. Every field of `AttachmentPolicy`
   comes from that ONE predicate through `attachmentPolicy()`, which takes a
   single boolean; add a field by deriving it too, and never special-case one
   field back when the predicate moves.

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
npm run e2e        # full loop over real sockets, no browser, 136 checks
npm run webmcp:harvest # our belief about the WebMCP draft, checked
npm run wire:check # wire validation: 515 fixture cases across all 45 frames
npm run agui:check # every emitted AG-UI event parsed by @ag-ui/core's schemas
npm run typecheck  # tsc -b over all packages
npm run deploy     # build the site + wrangler deploy

# these FIVE are checked separately, outside the project references — and
# they are the only thing that typechecks them at all, because every one is
# bundled by esbuild, which does not typecheck. A type error here still
# BUILDS and still ships.
npx tsc -p examples/inkwell/tsconfig.json
npx tsc -p site/tsconfig.json             # browser code (DOM lib)
npx tsc -p site/tsconfig.worker.json      # worker code (workers-types)
npx tsc -p wallet/tsconfig.json           # the hosted wallet origin app
npx tsc -p packages/extension/tsconfig.json --noEmit   # page provider, content script, SW
```

Browser and Worker type-check separately on purpose: `@cloudflare/workers-types`
and the DOM lib define conflicting globals, so mixing them in one project
produces nonsense errors.

The extension earned its place on that list the expensive way. It was in no
project for its whole existence, and `npm run check:extension` runs `tsx`,
which does not typecheck either — so four `Property 'answer' is missing in
type 'PageSession'` errors sat there from the day `AgentSessionHandle` gained
`answer()`, and the extension simply could not answer an elicitation. Nothing
reported anything. **A package that typechecks nowhere is where a shipped bug
hides**, and the only reliable fix is a command someone runs.

Env: `AGENTPORT_RELAY`, `AGENTPORT_IDENTITY`, `AGENTPORT_RUNTIME`,
`AGENTPORT_NAME`, `AGENTPORT_LOCATION`.

## UI framework

Everything user-facing is built with **nisli** (`@nisli/core`, Goga's own
signals + `html` template + custom-element framework; local checkout at
`/Users/goga/Documents/goga/nisli`). No VDOM, no compiler, no runtime deps —
which matters most for `connect.js`, since that ships into other people's
pages.

Registry ownership follows the trust boundary:

- **Our own pages** use `component()` in the document registry.
- **The extension transcript overlay** renders the same components in an
  extension-origin iframe. Its document and custom-element registry belong to
  the extension; the isolated content script injects only a plain iframe inside
  a closed shadow root and mediates a private `MessagePort`.
- **Injected consent UI** uses the `html` template layer only. A consent dialog
  must not depend on custom-element support or registry setup in the embedding
  page; its template owns its DOM outright.

`scripts/ui-smoke.ts` covers the site and injected template surfaces under
happy-dom. `scripts/extension-ui-smoke.ts` loads the real unpacked extension in
Chrome, verifies that the page cannot enumerate the iframe, and asserts the
shared `UI-CHAT` tree renders in the extension origin.

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

## What makes a check evidence

Every rule below was paid for by a check that looked green and proved
nothing. They are cheap to apply and each one has caught a real instance.

1. **Watch it fail.** Revert the fix in place and re-run. A check nobody has
   seen fail is not evidence — including a type-level assertion, where
   `const _: Unvalidated[] = []` is satisfied by an empty array whatever
   `Unvalidated` is.
2. **Fail for the right reason.** A check that can fail but cannot see the
   failure mode it was written for is not evidence either. If reverting the
   fix makes it fail with an unrelated message, it is testing something else.
3. **Never hang.** A check that hangs on the bug it targets is not a check at
   all: a hang is indistinguishable from slowness and nobody waits to find
   out. Every path that can refuse, deny or time out needs its own deadline.
4. **Beware string keys.** A check keyed on a string that another change may
   legitimately move has an expiry date — it stops being able to fail as a
   side effect of an unrelated edit, and still reports green.
5. **A failure is evidence about the check as often as about the code.** The
   reflex to fix the code first is how a correct implementation gets bent to
   match a wrong expectation.
5b. **When a new invariant appears, ask whether the existing suite is still
   shaped like the problem** — not whether you added a check. A suite whose
   scope was drawn before the constraint existed keeps passing forever and
   never mentions it. The wire harness had 500 fixture cases, a coverage gate
   and two exhaustiveness guards, and had never heard of `PROTOCOL_VERSION`,
   which is the field the wire's compatibility actually depends on.
6. **When you sabotage something to prove a check fires, read the failure and
   confirm it is the failure you intended.** A different red is not evidence,
   and it is harder to catch than no red because something *did* go red and
   you were looking for red. Renaming a `case` label to prove an exhaustive
   switch produced three errors, none of them the guard — a renamed case is
   not a missing case. Everything else here assumes the failure you observe
   is the failure you caused; this is the line that checks the assumption.
7. **A check that skips itself when its subject is unavailable is an
   anti-check.** It reports green precisely when it cannot look — unavailable
   in exactly the situation it existed for. `.catch(() => skip)` in a harness
   is `catch {}` wearing different clothes: forbidden in source since these
   tenets were written, and worse here, because in source a swallowed error
   loses information while in a check it manufactures a pass. This is rule 1
   with an extra step — not merely never watched failing, but structurally
   incapable of failing in the environment where it runs. The one instance was
   caught by re-reading, not by any failure, which is the least reliable
   detection method there is and was the only one left.
7b. **When something is hard to test where it sits, the difficulty is usually
   telling you where it belongs.** The classifier that could not be imported
   because its module touched `self` at load did not need a stubbed `self`; it
   needed to move to the file where the other pure rules already lived. The
   awkwardness was information, not an obstacle.
8. **When the only available check would lie, do not write it — record the
   gap and its cost.** A gap in the record looks like incompleteness; a
   passing check that proves nothing looks like rigour. Prefer the first.
   ADR-023 R9 is the worked example.

And three shapes of one disease, all found in a single day, all of them the
failure path being incomplete while the happy path is fine: a handler set the
compiler cannot check (a message arrives and nobody is listening); a check
that hangs rather than fails; and a throw inside a request handler (a message
never leaves and the peer listens forever). See ADR-023 R8.

## Errors and logging

- Every catch block either rethrows or logs through the shared logger with a
  component and relevant context. A bare `catch {}` requires a comment proving
  that silence is safe.
- Errors that cross an async boundary (event handlers, fire-and-forget
  promises, socket callbacks) MUST be caught and logged. A floating promise
  rejection is a bug.
- User-visible failures are logged AND surfaced in the UI. Log-only is not
  surfacing.
- New subsystems accept a `Logger` (or use `createLogger`), never a bare string
  callback.
- Raise verbosity with `AGENTPORT_LOG=debug` in Node or
  `localStorage['agentport.log'] = 'debug'` in a browser. Inspect the current
  page's ring buffer with `window.__agentport?.logs()`.

## Conventions

- ESM everywhere, `.js` extensions in relative imports (TS `Bundler`
  resolution, `verbatimModuleSyntax`).
- Workspace packages point `main` at `src/*.ts`; consumers bundle or run via
  `tsx`. No build step needed for development.
- `strict` + `noUncheckedIndexedAccess` are on. Keep them on.
- No dependency may be added to `@agentport/protocol` or `@agentport/client`
  that assumes Node. Both must run in a browser.
- Comments explain *why* a boundary exists, not what a line does.

## Wire validation

Everything about the wire lives in three files, and adding a frame or a field
means touching them and nothing else:

- `packages/protocol/src/schema.ts` — the combinator core. Hand-rolled, no
  dependency: this ships inside `connect.js`, into other people's pages. Exact
  objects (an unknown key rejects, which is what makes `__proto__` smuggling
  structurally impossible), no coercion anywhere, validated values rebuilt onto
  fresh objects, and `WireViolation{code, path}` whose code comes from a closed
  set and whose path contains only schema-defined names. Attacker bytes never
  reach a log, an error frame, or a metric.
- `packages/protocol/src/limits.ts` — every bound, each with the reasoning that
  chose it. Change a limit here, not at a call site.
- `packages/protocol/src/messages.ts` — one schema per frame, `FRAME_SCHEMAS`
  as the registry, and the exported types **inferred** from the schemas. There
  is no second hand-written interface to drift from.

**Every registry in that file is type-linked, and that is load-bearing.** A
frame type appears in several of them, and each one that the compiler could not
check has already been wrong at least once:

- `FRAME_SCHEMAS` and `SESSION_FRAME_TYPES` are **total** over their unions.
  `SESSION_FRAME_TYPES` was a plain `Set<string>`; a frame missing from it
  compiled cleanly and was then silently dropped at the wallet's router.
- `CLIENT_SEALABLE` / `AGENT_SEALABLE` are **exhaustive over content frames**,
  proved by an `AssertNever` alias. This is the one that matters most: both
  endpoints decide whether to seal by asking `SEALED_TYPES.has(frame.t)` and
  otherwise send the frame as-is, so a content frame missing from both sets was
  sent **in the clear**. The relay refuses it — after decoding it, and the relay
  is the party ADR-003 exists to blind.
- `CLIENT_ORIGINATED` / `AGENT_ORIGINATED` are deliberately **partial**: a frame
  missing from them is denied, which is already fail-closed, so only a
  non-existent frame name needs catching. Do not "fix" these to be total.

The rule, learned three times in one day (here, and at the extension's
`PageOutbound` boundary): **a registry the compiler cannot check is a registry
that will eventually be wrong.** When you add one, make an omission a type
error, and then delete an entry once to watch the build fail — a guard nobody
has seen fire is not evidence.

The wire form is **AgentPort canonical JSON v1** = `canonicalJson()`: keys
sorted by UTF-16 code unit, no whitespace, ECMAScript number and string
serialization. Each frame therefore has exactly ONE valid encoding, and
`decodeFrame` rejects every other spelling (`non_canonical`) — which is what
closes duplicate keys and ambiguous representations without writing a parser.
Ordering and escaping line up with RFC 8785 (JCS) over the value space the
schemas admit, but do not call it JCS; it is not a certified implementation.
Deliberately, this is the *same* function that canonicalizes cert and
delegation bodies for signing: one dialect, not two that drift.

Consequence: **the relay and the endpoints deploy together.** An older peer
emitting insertion-order JSON is rejected visibly rather than slipped into an
ambiguous-parse gap. The relay already rejected unknown frame types, so
protocol changes already required deploying it first; this widens that to
field-level changes.

Two rules that are easy to get wrong:

- **Sender-side bounds come before the counter moves.** `seal()` refuses an
  oversized plaintext before `encrypt()` advances the nonce, so a local bug
  cannot spend a counter on a frame the peer will reject.
- **Classify sealed failures by whether the peer was authenticated.** The
  nonce is compared before the AEAD tag, so a wrong nonce — replayed, skipped,
  or fabricated — costs an on-path observer nothing to produce. It and any
  tamper failure leave the channel untouched: drop, continue, and let liveness
  timeouts handle a genuinely stalled session. Only a `WireViolation` from
  `openSealed`, which can only be raised *after* the tag verified, is
  session-fatal: the peer itself sealed something invalid or forbidden.
  Getting this backwards hands a passive intermediary a kill switch over
  every session it can see — `npm run wire:check` asserts the split directly.

`npm run wire:check` is the acceptance gate: fixtures in
`scripts/fixtures/wire/` (valid, boundary, and hostile cases per frame type),
a coverage gate over `FRAME_SCHEMAS`, programmatic bounds, and sealed-path
tests using the real crypto. A new frame type fails the coverage gate until it
has fixtures.

## State of things

Working: pairing, cert issuance and verification, directory + presence,
capability grants with TTL, prompt streaming, plan reporting, tool-call
round-trip, approval round-trip, cancellation, reconnect with in-place session
resume, session teardown, revocation, authority-tagged approvals, the agent
asking its own user a question, and the full demo UI. 136 e2e checks and 515
wire-validation cases pass.

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

   Note what this does *not* block: `#hasTrustedAnswerSurface` keys on
   DELEGATION, not on the wallet's implementation, so the extension already
   counts as a trusted answer surface and already gets own-tool approvals and
   elicitation. The in-page demo wallet is in the same row, and allowing it
   costs nothing — a page holding the user key can already mint any authority
   it likes, so refusing to ask it protects nothing (invariant 8's
   self-referential argument). Extension packaging is what turns that row from
   *vacuously* safe into *genuinely* safe, and needs no policy change when it
   lands.
4. **WebMCP interop — partial, and deliberately so.** Both connect.js and the
   extension harvest `document.modelContext` registrations (with the deprecated
   `navigator.modelContext` fallback) into `SiteTool`s at attachment time, and
   every harvested tool is gated: a page authors the metadata, so a page cannot
   decide what needs approving. What we do NOT implement is enumerated in
   `WEBMCP_NOT_IMPLEMENTED` (`packages/client/src/webmcp.ts`), which is the
   single source for the negative claim — ADR-006 points at it rather than
   restating it. The old "every WebMCP-adopting site becomes compatible" was
   withdrawn: it was false, and it is why nobody looked for five months.
5. ~~Revocation.~~ **Done (ADR-022).** The revocation object is the
   `SessionDelegation`, addressed by its origin, and a revocation is a
   *tombstone* (`{origin, at}` refuses delegations issued at or before `at`),
   not a denylist — so approving again works with no un-revoke verb, and the
   store stays finite because a delegation's lifetime is bounded. Two frames
   (`revoke`/`revoked`, owner-key only, never a delegated page key), a daemon
   `revoke()`/`unpair()`, and `agentport status|revoke|unpair` over the
   control file. Revoked means **unresumable at the daemon**, not just closed
   — the client redials by itself now.
6. ~~Reconnect + session resume.~~ **Done.** An unexpected socket close
   redials with bounded backoff and re-resumes every live session in place, so
   the page keeps the handle (and the listeners) it already had. Fresh keys per
   ADR-003 mean the fingerprint words change, which the panel shows as
   persistent state. e2e section 12b kills the socket from outside and proves
   the same handle still drives the agent.

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
