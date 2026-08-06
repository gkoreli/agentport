# Changelog

What changed and why it mattered. Newest first.

Versions are the root `package.json` version, which `npm run deploy` bakes
into the site bundle and the extension build stamp — so a version in a panel
header or an extension popup names exactly one commit. Separately versioned
npm artifacts (`@gkoreli/agentport`, the shared chat overlay) are noted where
they moved.

## 0.0.11

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
