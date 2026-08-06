# Changelog

What changed and why it mattered. Newest first.

Versions are the root `package.json` version, which `npm run deploy` bakes
into the site bundle and the extension build stamp — so a version in a panel
header or an extension popup names exactly one commit. Separately versioned
npm artifacts (`@gkoreli/agentport`, the shared chat overlay) are noted where
they moved.

## Unreleased

### The agent's plan is a thing you can watch

ACP agents already report a structured plan — `session/update` with
`sessionUpdate: "plan"`, carrying entries with content, priority and status,
re-sent as a whole whenever it changes. The daemon dropped every one of them:
`#sessionUpdate` had no `plan` case, so they fell through `default: return`.
The user watching the panel saw prose and status lines but never the plan,
which on a multi-step flow is the only honest answer to "what is it doing and
how far along is it". This was free progress reporting we were receiving and
discarding.

It now crosses the wire as its own sealed content frame and renders as a live
checklist above the transcript.

- **Snapshot, not delta.** `plan` carries the whole checklist every time and
  replaces the previous one. Runtimes rewrite plans as they discover work, and
  a partial update whose base had been dropped would render a plan that never
  existed.
- **Statuses are renamed, not passed through.** ACP's `in_progress` describes a
  task; our `active` describes what the user is watching happen. The wire
  vocabulary should not become a second spelling of someone else's enum.
- **No relay deploy.** The relay only ever sees `enc`, so a new *sealed* frame
  type is invisible to it — the first wire change here that does not need
  lockstep. Lifecycle frames still do.
- **The transcript does not record it.** A plan is the current intention; a
  replay of every revision would read as repetition rather than as the
  conversation. On resume the panel starts with no plan rather than a stale one.
- **`@ag-ui/core`'s own event.** The adapter emits `ACTIVITY_SNAPSHOT` with
  `activityType: 'plan'` and `replace: true` — a standard AG-UI renderer shows
  agent progress with zero AgentPort-specific code, which is the ADR-017 claim
  actually being paid off rather than asserted.
- `DemoWriterRuntime` reports and advances a plan, so the path is exercised
  without an LLM — the repo's dogfooding rule: an abstraction nobody calls is
  decoration.

Found while building it: `messages.ts` had a **fourth** place a frame type must
be registered — a hand-written `SESSION_FRAME_TYPES` set with no type link to
the `SessionFrame` union. Adding a frame and forgetting it compiled cleanly and
then silently dropped the frame at the wallet's router. It is now a total record
over `SessionFrame['t']`, so an omission is a type error, like `FRAME_SCHEMAS`.

Evidence: `npm run e2e` (79 checks; four new ones prove a plan crosses the
sealed channel, that every snapshot carries the whole checklist, and that the
statuses actually advance), `npm run wire:check` (459 cases across 41 frame
types, including hostile plan fixtures), `npm run agui:check` (both snapshots
parsed by `@ag-ui/core`'s own schemas, same `messageId`, `replace: true`), and
`npm run ui:smoke` (the real panel renders a plan and a second snapshot
replaces it in place — seven checks that fail if the handler is removed).

### One "Approve" no longer selects allow_always

`AcpRuntime`'s permission answer searched the runtime's option list for
either `allow_once` or `allow_always` and took whichever the runtime listed
first. The runtime controls both the options and their order, so a runtime
listing `allow_always` first turned a single user "Approve" into standing
approval for every later call in the attachment — the user answered one
question and the daemon recorded a different one. Same trap on the deny side
(`reject_always` could silently suppress every future ask).

The daemon now selects only the `*_once` option matching the user's answer,
and cancels when the runtime offers no once-option at all — a durable choice
is never made on the user's behalf. `npm run acp:check` (new) drives the real
`AcpRuntime` over stdio against a scripted hostile agent
(`scripts/fixtures/acp/hostile-permission-agent.mjs`) that orders and prunes
its permission options adversarially; four of its six checks fail against the
previous selection logic. The daemon-side fix landed alongside eaa2009; this
entry names the change.

### Use AG-UI instead of restating it

`packages/agui` hand-declared the AG-UI event types instead of importing
`@ag-ui/core`, and that copy was missing `TOOL_CALL_RESULT` — so the adapter
stuffed a tool's return value into `rawEvent` on `TOOL_CALL_END`, where no
standard renderer looks. A standard AG-UI component rendering an AgentPort
session showed tool calls and never their results, which made ADR-017's central
claim ("any AG-UI-compatible component can render an AgentPort session with
zero custom code") false from the day it was written. The root cause is in the
deleted implementation report: the package was uncached in an offline sandbox,
so the types were written by hand against a web reference.

- Event types now come from `@ag-ui/core` (pinned `^0.0.57`), re-exported under
  the same names so consumers are unchanged. Taking the dependency is safe
  here: it brings zod, which the bundle rules for `@agentport/protocol` and
  `@agentport/client` forbid, but the dependency direction is agui → client and
  never the reverse, and the adapter is consumed only by our own demo surfaces.
  Measured: +69 kB to `inkwell.js` and `tasker.js`, **0 to `connect.js`**, the
  drop-in that ships into other people's pages.
- The adapter now emits a real `TOOL_CALL_RESULT`, and `TOOL_CALL_END` is
  spec-pure. A failed tool call is a result with an error, not a failed run.
- `packages/agui/check.ts` existed but nothing ran it. It is now
  `npm run agui:check`, and it parses **every** emitted event against
  `@ag-ui/core`'s own runtime schemas, so the next drift from the spec fails
  the check instead of shipping.

ADR-017 records the corrected reasoning. The line it used to carry — revisit
AG-UI alignment "only if it clearly wins its layer; premature while the spec is
young" — was backwards: a young, fast-moving spec is an argument *for*
depending on the package, because its versioning tells you when you have
drifted, while restating it locally is how you drift silently. The repo has now
been bitten by that twice; the WebMCP harvester is the other case, and it says
so itself.

### The north star, written down

`docs/NORTH-STAR.md` — what this is for, what "the site learns nothing"
enumerates, what we will never be, what has to stay true, and how we would know
it worked. The part worth having explicit is the hierarchy: AG-UI, WebMCP, MCP
and ACP are components we use, not competitors and not layers to negotiate
with. AG-UI in particular normalizes the agent-to-client edge for a builder who
controls their own agent — the assumption this project removes.

## 0.0.12

Deployed. `npm run deploy` bumps the patch itself, so this work — written up
below under the 0.0.11 bump that preceded it — shipped as 0.0.12. The number in
a panel header names the deployed artifact, so that is the number this entry
carries.

### One strict schema layer for the whole wire (ADR-019 Gate B §1)

`decodeFrame` used to be `JSON.parse` plus a single `typeof` check, and the
sealed path was worse — decrypted plaintext went straight into a TypeScript
cast. TypeScript types offered no protection against a hostile socket. That is
now closed.

- **Every frame is defined once**, as a runtime schema in
  `packages/protocol/src/messages.ts`, and the exported TypeScript types are
  *inferred* from those schemas. A validator and its type can no longer drift,
  because there is only one of them.
- **`decodeFrame` is the only route to a typed frame**: byte cap → raw nesting
  scan (before anything recursive runs) → parse → byte-exact canonical form →
  exact-type registry lookup → strict validation. It returns a rebuilt frame or
  throws `WireViolation{code, path}`, whose code comes from a closed set and
  whose path contains only schema-defined names. Attacker bytes never reach a
  log, an error frame, or a reply.
- **`openSealed` applies the same decoder to decrypted plaintext** and enforces
  the per-direction sealable sets, which moved into `@agentport/protocol` from
  duplicated copies in the daemon and the wallet.
- **The wire form is now `canonicalJson`** — sorted keys, one valid encoding
  per frame. This is what closes duplicate keys and every other ambiguous
  spelling without writing a parser, and it is the same function that
  canonicalizes signature bodies, so there is one dialect rather than two that
  drift.
- **Bounds live in `packages/protocol/src/limits.ts`**, each with the reasoning
  that chose it, including the aggregate tool-definition budget ADR-019 names.

Hand-rolled rather than adopting a schema library, after an independent review
of zod, zod mini, valibot, superstruct, typebox, arktype, and schemasafe: this
code ships inside `connect.js` into third-party pages, and every candidate
still leaves the canonical, sealed, and budget work to us. The whole layer
costs **3.0 kB gzip** — less than the smallest library before any of the custom
work it would still have required.

Two rules that are easy to get backwards, both now asserted by tests:

- **Sender-side bounds run before the counter moves.** `seal()` runs the
  receiver's own `decodeFrame` before `encrypt()`, so a runtime handing us an
  oversized string fails as a local bug instead of tearing down the peer's
  session.
- **Only post-authentication failures are fatal.** The nonce is compared before
  the AEAD tag, so a forged one costs an on-path observer nothing. Nonce
  mismatches and tamper failures are dropped and the session continues; only a
  `WireViolation` from `openSealed` — which can only be raised after the tag
  verified — ends a session.

### Also hardened, from the same boundary (partial ADR-019 §2)

- Per-socket malformed-frame budget; a socket that keeps sending garbage is
  disconnected. Legitimate peers produce zero.
- `maxPayload` on both Node WebSocket ends (the default was 100 MB), and
  text-frame-only ingress on every host, so binary can no longer become a
  second spelling of a frame.
- The relay's `internal` error reply no longer echoes raw JavaScript error
  text back to the peer.
- Routing entries are released on `session.denied` and on disconnect.
- Pending resumes pin the agent they were routed to, so no other authenticated
  agent can answer a resume it was never asked about.
- The relay strips `viaConnect` when stamping, so a client cannot redirect its
  own approvals to a terminal nobody is watching.
- A client handshake deadline, so a dropped reply fails loudly instead of
  hanging forever.
- `history` frames are bounded and carry `truncated` when the daemon dropped
  entries, rather than presenting a partial transcript as the whole
  conversation. `HistoryEntry.at` admits `0` for "unknown", because ACP replay
  has no timestamps and a fabricated one would be worse than none.

### Evidence

- `npm run wire:check` (new) — 434 fixture cases across all 40 frame types,
  plus a coverage gate over the registry, programmatic bounds, sealed-path
  checks on real crypto, and registry/encoding properties.
- `npm run e2e` — 74 checks over real sockets, including new adversarial checks
  for resume answer-forging.
- `npm run integration` against a local relay, `ui:smoke`, `wallet:check`,
  `check:extension`, workspace typecheck and the four out-of-references
  projects.

Nine defects found by two independent reviews were fixed before landing;
`docs/ADR-019-security-hardening.md` lists each with the check that now covers
it.

**Deployment note:** canonical form and strict types mean relay and endpoints
must deploy together. The relay already rejected unknown frame types, so
protocol changes already required deploying it first; this widens that to
field-level changes.

## 0.0.10 and earlier

Reconstructed from the release history; see `git log` for detail.

- **0.0.11** — never deployed; superseded by the 0.0.12 release bump above.
- **0.0.10** — browser approvals made deterministic; ACP state bound to
  explicit attachments; `@gkoreli/agentport` CLI to 0.1.5; shared chat overlay
  to 0.0.9.
- **0.0.9** — ACP tool lifecycle made cancellation-safe.
- **0.0.8** — hosted-wallet tier finished on hardened main; pairing without
  restarting the daemon; delegated session response metadata authenticated;
  correlation waiters no longer outlive their answer.
- **0.0.7** — CLI published under the owned npm scope.
- **0.0.6** — pairing links routed to the pairing page.
- **0.0.5** — pair an agent with one command; hosted wallet tier (own-origin
  popup, scope-bound delegations, the connect ladder).
- **0.0.4** — extension build-stamped version, contract revision, update
  handshake, and conformance guards; extension session contract enforced.
- **0.0.3** — extension page proxy speaks the current session interface;
  ADR-019 recorded.
- **0.0.2** — structured logger in the protocol package, adopted everywhere;
  E2EE hardening; chat UI decoupled.

Before versioning existed: the initial `navigator.agent` implementation, the
ACP runtime adapter, `RelayCore` extraction, the deployed demo surfaces, the
MV3 extension wallet, `connect.js` with consent at the daemon, end-to-end
sealing (ADR-003), session resume with the transcript owned by the user's
agent, the stateless relay (ADR-016), WebMCP harvesting (ADR-006), and the
AG-UI adapter (ADR-017).
