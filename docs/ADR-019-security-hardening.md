# ADR-019: Security hardening gates customer adoption

- **Status:** accepted; implementation pending
- **Date:** 2026-08-02
- **Owners:** AgentPort maintainers
- **Depends on:** ADR-003, ADR-005, ADR-009, ADR-014, ADR-016, ADR-018

## Context

ADR-003 ships mandatory end-to-end sealing and ADR-018 records the current
security architecture. The cryptographic channel now fails closed: there is no
plaintext fallback, handshake proofs bind the session decision context,
directional keys and counters reject replay and reordering, and resume creates
a fresh attachment.

That is sufficient for a constrained design-partner pilot. It is not, by
itself, sufficient for broad customer adoption. A production security boundary
also needs hostile-input validation, production key custody, complete
adversarial coverage, revocation, bounded resource use, prompt-injection
containment, operational response, and independent review.

This record decides the next hardening work and the adoption gates it controls.
It is a delivery ADR, not a claim that the work below already exists. ADR-018
remains the authoritative description of shipped security behavior.

## Decision

Security hardening proceeds in three gates. Work is ordered by the consequence
of failure, not implementation convenience. A later gate cannot compensate for
an unfinished earlier gate, and no control may introduce a compatibility,
plaintext, or heuristic fallback.

1. **Gate A — controlled design partners:** narrowly scoped pilots may run now
   under explicit operational constraints.
2. **Gate B — expanded customer beta:** requires strict wire validation,
   production browser custody, complete boundary tests, and revocation.
3. **Gate C — general availability:** additionally requires runtime
   containment, operational security, continuous fuzzing, and independent
   review with high-severity findings resolved.

## Gate A: controlled design-partner pilot

Gate A is appropriate for a small number of technically engaged customers who
understand that AgentPort has not received an independent security audit.

Every Gate A deployment must satisfy all of the following:

- Use the drop-in flow with consent at the daemon, or a maintainer-controlled
  extension build. A customer site must never receive a persistent user secret
  key.
- Require the six-word fingerprint comparison for drop-in first contact.
- Use a dedicated, least-privileged runtime identity and separate test data.
- Grant only the tools required by the pilot. Every mutation or externally
  visible action requires approval.
- Exclude regulated data, production credentials, financial authority,
  destructive infrastructure access, and irreversible operations.
- Document a kill procedure: stop the daemon, remove its certificate at the
  edge, and invalidate any associated runtime credentials.
- Give the customer a private incident-reporting channel and identify a human
  who can disable the deployment.
- Describe the release as early access, not audited or generally available.

Gate A does not authorize arbitrary websites or unattended use.

## Gate B: expanded customer beta

All Gate B items are release blockers.

### 1. Strict, bounded wire validation

`decodeFrame()` currently establishes only that input is JSON, is an object,
and contains a string `t`. TypeScript types provide no protection against a
hostile socket at runtime.

Replace that boundary with one canonical runtime schema for every protocol
version and frame type. The schema layer must:

- discriminate by exact protocol version and frame type;
- reject unknown frame types and unknown security-relevant fields;
- validate required and optional fields without coercion;
- validate hexadecimal fields for alphabet and exact byte length;
- validate timestamps as safe integers within their protocol domain;
- bound frame bytes, strings, arrays, object properties, schema depth, and
  aggregate tool-definition size before expensive processing;
- bound ciphertext and decrypted plaintext independently;
- reject duplicate or ambiguous representations;
- return typed frames only after successful validation;
- produce stable public error codes without reflecting attacker-controlled
  payloads into logs or responses; and
- apply the same definitions in the relay, daemon, wallet, extension, site,
  tests, and generated documentation.

There must be one source of truth. Hand-maintained TypeScript interfaces and
separate validators that can drift are not acceptable. If a schema library is
selected, it must be browser-safe, have no Node assumptions in protocol or
client packages, support strict objects and size refinements, and survive a
bundle-size and maintenance review before adoption.

Acceptance evidence:

- a table test with at least one valid and multiple invalid examples for every
  frame type;
- rejection tests for missing, extra, wrong-type, truncated, oversized, deeply
  nested, non-canonical, and boundary-sized fields;
- unchanged validation behavior in Node, browser, and Worker builds;
- no handler receives an unvalidated frame; and
- fuzz seeds for every frame type are checked into the repository.

### 2. Resource and abuse bounds

Cryptographic integrity does not prevent authenticated clients from exhausting
memory, CPU, sockets, pending promises, or runtime sessions.

Enforce explicit limits for:

- pre-authentication bytes, frames, and authentication attempts per socket;
- pairing/connect-code creation and guesses per source and time window;
- concurrent sessions per client, agent, and socket;
- tools per grant and bytes per tool schema;
- pending prompts, tool calls, approvals, history requests, and resumes;
- prompt, delta, tool-argument, tool-result, history, and transcript sizes;
- session lifetime, detached-session grace, and idle time;
- malformed frames and cryptographic failures before disconnect; and
- reconnect attempts and backoff.

Limits must be constants with rationale, observable counters, deterministic
error behavior, and boundary tests. Exceeding a limit fails the operation or
closes the abusive connection; it never disables validation or sealing.

### 3. Production browser custody and origin attestation

The in-page wallet is a demo and cannot be offered as production key custody.
Complete the extension boundary required by ADR-009:

- page JavaScript never receives the user secret key, agent device key,
  attachment secret, resume token, or raw ownership store;
- the extension derives the requester origin from browser-provided sender
  metadata, never a page-supplied string;
- identities exposed to pages are pairwise per origin and cannot become a
  cross-site identifier;
- grants and approvals are rendered in extension chrome that the page cannot
  draw or clickjack;
- the user key is wrapped at rest and requires an explicit session unlock;
- resume records remain extension-only, session-scoped, origin-bound, and
  expiry-bound;
- injected/page messages use an exact allowlist, source/origin checks, request
  identifiers, and replay protection; and
- extension update, migration, and worker-eviction paths preserve fail-closed
  behavior.

Acceptance evidence includes malicious-page tests for forged origin, forged
approval, cross-origin identity correlation, token extraction, message replay,
worker restart, tab replacement, and confused-deputy routing.

### 4. Complete adversarial invariant coverage

Add direct, non-vacuous tests for every ADR-018 enforcement row. At minimum:

- invalid ownership-certificate signature, agent rebinding, user rebinding,
  and certificate replay;
- substitution of self-reported client or agent identity against the relay
  stamp and daemon re-check;
- expired grant at open, tool call, approval return, detach, and resume
  boundaries;
- every forbidden client/agent lifecycle and sealed inner-frame direction;
- non-participant injection for lifecycle and ciphertext frames;
- handshake-proof replay across session, mode, surface, grant, peer, and resume
  authority;
- old attachment ciphertext rejected after resume;
- old and resumed attachments demonstrably derive different keys;
- resume token theft by the wrong identity, live-session replacement, attempt
  exhaustion, and indistinguishable invalid-session responses;
- plaintext content in every content direction; and
- malformed ciphertext that fails without advancing channel state.

Tests must attack the real relay, wallet, and daemon over sockets. Unit tests
may supplement them but cannot replace boundary evidence.

### 5. Revocation and emergency stop

Revocation must be usable without editing files or understanding the wire
protocol:

- list owned agents and their certificate fingerprints;
- revoke an agent from the wallet/extension;
- remove the certificate from the daemon and disconnect all live sessions;
- reject future connections using revoked or absent ownership state;
- close affected sessions with a stable reason while revealing no content;
- support a daemon CLI kill/list/revoke path when the browser is unavailable;
  and
- document recovery after a lost browser, lost daemon, or suspected key theft.

The relay remains stateless and does not become a revocation authority.
Durable revocation state belongs at the wallet and daemon edges.

### Gate B exit criteria

Gate B is complete only when:

- all five sections above ship in the product paths used by the pilot;
- all repository typechecks, E2E, integration, extension, Worker, and UI smoke
  checks pass from a clean checkout;
- the security test matrix has no untested ADR-018 invariant;
- documentation accurately lists every relay-visible field and persistent
  record; and
- a maintainer performs and records a focused security review of the complete
  diff.

## Gate C: general availability

### 6. Prompt-injection and runtime containment

Approval is necessary but insufficient when the borrowed agent also holds the
user's unrelated personal tools. A poisoned page can influence model behavior
before a site-tool approval occurs.

Before general availability:

- each AgentPort session receives an explicit allowlist for the runtime's own
  tools, not only the site's lent tools;
- unrelated filesystem, shell, mail, browser, credential, and network tools
  are absent by default;
- the MCP bridge remains loopback-only, token-scoped, session-scoped, and is
  withdrawn on close, expiry, detach timeout, and daemon shutdown;
- tool results are marked and handled as untrusted data at the runtime
  boundary;
- destructive or externally visible operations require a trusted approval
  surface with complete, bounded arguments; and
- tests use adversarial site content and tool results to attempt cross-tool
  exfiltration and privilege escalation.

Prompt text alone is not a control. If the selected runtime cannot enforce its
own-tool allowlist, that runtime is not eligible for general-availability use.

### 7. Key lifecycle and recovery

- Define key generation, storage, wrapping, unlock, rotation, backup,
  revocation, and destruction behavior for user and daemon identities.
- Detect corrupt, truncated, mismatched, or permission-unsafe identity files
  and fail closed.
- Never log secret keys, attachment secrets, resume tokens, prompts, tool
  arguments, results, or transcripts.
- Rotate compromised device certificates without restoring old authority.
- Document that JavaScript cannot guarantee physical zeroization and avoid
  claiming otherwise.
- Test upgrade and recovery paths, including interrupted writes and rollback to
  an older application version.

### 8. Supply-chain and release integrity

- Pin and review security-critical dependency updates; prohibit floating
  versions in release artifacts.
- Generate an SBOM and preserve license/provenance information.
- Run dependency vulnerability review, secret scanning, static analysis, and
  reproducible clean-install tests in CI.
- Minimize the browser/extension dependency graph and record bundle changes for
  cryptographic and parsing dependencies.
- Protect release signing and deployment credentials with separate,
  least-privileged identities.
- Publish immutable version and source-revision information in every daemon,
  extension, site, and relay artifact.

### 9. Privacy-preserving observability and incident response

Operational visibility must diagnose abuse without becoming a second data
store.

- Define structured security events for authentication failure, validation
  failure, limit exhaustion, grant denial, approval denial, resume denial,
  ciphertext failure, revocation, and version mismatch.
- Log stable codes and coarse counters, never session content or bearer
  secrets.
- Bound retention and document which operator can access logs.
- Add health and abuse metrics that cannot reconstruct conversations.
- Publish `SECURITY.md` with a private reporting channel, supported versions,
  response targets, disclosure process, and emergency-disable procedure.
- Maintain an incident runbook for key compromise, malicious relay behavior,
  vulnerable dependency, extension compromise, and leaked deployment secret.

### 10. Continuous fuzzing and independent review

- Fuzz frame parsing, canonical JSON, signature bindings, ciphertext opening,
  state-machine transitions, resume, and relay routing.
- Add property tests for canonicalization, directional-key agreement, nonce
  monotonicity, state advancement only after authentication, and protocol
  version separation.
- Run cross-runtime vectors in Node and browsers for every cryptographic wire
  primitive.
- Commission an independent review covering protocol design, browser extension
  isolation, daemon/ACP/MCP containment, relay abuse, and deployment.
- Resolve every critical and high finding before general availability. Medium
  findings require fixes or an explicit, dated risk acceptance in a new ADR.
- Never describe AgentPort or its dependencies as audited unless the exact
  reviewed version and report are public and applicable.

### Gate C exit criteria

General availability requires:

- Gate B complete;
- runtime own-tool containment enabled by default;
- key lifecycle, release integrity, observability, and incident response
  documented and tested;
- continuous parser/protocol fuzzing running in CI or a hosted fuzzing service;
- an independent review completed against a release candidate;
- all critical/high findings resolved and retested; and
- the deployed daemon, extension, relay, and site matching the reviewed source
  revision.

## Priority order

Implementation order is fixed unless a new security finding justifies a new
ADR:

1. strict runtime wire schemas and size bounds;
2. adversarial tests for the current invariants;
3. extension custody and origin attestation;
4. resource/abuse limits;
5. revocation and emergency stop;
6. runtime own-tool containment;
7. key lifecycle and recovery;
8. supply-chain and release integrity;
9. privacy-preserving observability and incident response;
10. continuous fuzzing and independent review.

Strict validation comes first because every internet-facing component
currently accepts structurally shallow objects. Tests come immediately after
the contract so every later control builds on executable hostile-input
behavior.

## Change discipline

- Each hardening item is implemented in the real product path and removes any
  superseded path in the same change.
- Security controls default to enforcement. A feature flag may make a feature
  unavailable; it may not select weaker authentication or encryption.
- Errors are explicit and observable without exposing secrets.
- New protocol versions are negotiated explicitly and rejected when unknown.
  Current-version parsing never guesses a legacy shape.
- Every completed item updates ADR-018, this roadmap, and the security test
  matrix in the same change.
- Gate status changes require a recorded commit and evidence links; passing a
  date or acquiring a customer does not waive a gate.

## Consequences

AgentPort can pursue customer learning now without confusing a functional E2EE
channel with a completed production security program. The cost is deliberate:
expanded adoption waits for hostile-input and custody boundaries, general
availability waits for containment and independent review, and availability
may fail before confidentiality or authority is weakened.

This sequencing keeps the product moving while preserving the core rule:
security failures are explicit states to fix, never reasons to add a fallback.

## Delivery log

### Gate B §1 — strict, bounded wire validation: shipped 2026-08-06

One canonical schema layer now governs every frame. `packages/protocol/src/`
gains `schema.ts` (hand-rolled combinators, chosen over a library because this
code ships inside `connect.js` into third-party pages) and `limits.ts` (every
bound with its rationale); `messages.ts` defines each frame once as a schema
and *infers* the exported TypeScript types, so no hand-maintained interface
survives to drift. `decodeFrame` bounds size, scans raw nesting depth before
any recursive work, parses, requires byte-exact `canonicalJson` form, looks the
type up in `FRAME_SCHEMAS`, and validates strictly — returning a rebuilt frame
or throwing `WireViolation{code, path}` built only from schema-defined names.
`openSealed` applies the same decoder to decrypted plaintext and enforces the
per-direction sealable sets that moved into the protocol package from their
duplicated copies in the daemon and wallet.

Against the section's acceptance list:

- *Discriminate by exact type; reject unknown types and unknown fields* —
  `FRAME_SCHEMAS` exact lookup; `obj()` rejects any unlisted key.
- *Validate without coercion; hex alphabet and exact byte length; timestamps as
  safe integers in the protocol domain* — `hex()`, `int()`, and the
  `[2020, 2100]` timestamp domain. `HistoryEntry.at` additionally admits `0` as
  an explicit "unknown", because ACP replay carries no timestamps and inventing
  one would be worse than admitting none.
- *Bound frame bytes, strings, arrays, object properties, schema depth, and
  aggregate tool-definition size before expensive processing* — `limits.ts`,
  plus the pre-parse depth scan and the ws `maxPayload` on both the relay and
  the daemon client.
- *Bound ciphertext and decrypted plaintext independently* — `hexRange` on
  `enc.c`; `MAX_SEALED_PLAINTEXT_BYTES` checked after decrypt, and again in
  `seal()` before the nonce advances.
- *Reject duplicate or ambiguous representations* — the canonical-form check
  (duplicate keys, key-order variance, whitespace, `\/` escapes, `1e3`, `-0`),
  lowercase-only hex, and unpaired-surrogate rejection on free-form strings.
  `CapabilityGrant` further refines: unique tool names (the wallet resolved
  duplicates last-wins while the daemon resolved them first-wins — an attacker
  choice), and `alwaysAsk` unique and a subset of the granted tools.
- *Typed frames only after validation; stable public error codes with no
  payload reflection* — both hold; the relay's `internal` reply no longer
  echoes raw JavaScript error text, and repeated malformed frames now cost the
  socket (`MAX_MALFORMED_FRAMES`).
- *Same definitions in relay, daemon, wallet, extension, site, and tests* —
  all consume `@agentport/protocol`. The extension holds no wire parser of its
  own; its ingress is `AgentWallet`.

Evidence: `npm run wire:check` — 411 fixture cases across all 40 frame types
(valid, boundary-accepted, missing/unknown/wrong-type/oversize/deep, and raw
hostile seeds including non-canonical and `__proto__` smuggles), a coverage
gate over `FRAME_SCHEMAS`, programmatic bounds, and sealed-path checks on real
crypto. `npm run e2e` — 72 checks over real sockets. `npm run integration`
against a local relay — full ACP-shaped stack. `npm run ui:smoke` — 33 checks.
`npm run typecheck` plus the four out-of-references projects and
`npm run check:extension`.

Delivered incidentally from §2 (resource and abuse bounds), because the checks
belong to the same boundary: per-socket malformed-frame budget, `maxPayload` on
both Node WebSocket ends, text-frame-only ingress on every host, routing-entry
cleanup on `session.denied`, and a client handshake deadline so a dropped reply
fails instead of hanging forever.

Deliberately still open in §2: per-client/agent/socket session quotas,
pre-authentication byte budgets, pairing-claim rate limits, and pending-map
caps and sweeps.

Two behavioral consequences worth stating plainly:

1. **Deployment is lockstep.** Canonical form and strict types mean a peer
   running older code is rejected. The relay already rejected unknown frame
   types, so protocol changes already required deploying it first; this widens
   that to field-level changes. `scripts/deploy.ts` ships the Worker and the
   wallet together.
2. **`session.opened`/`connect.begin` without sealing proofs die at the relay's
   decoder**, not at the daemon — the schema requires `epk`/`epkSig`. The
   daemon's `sealing_required` check is NOT dead and was not deleted: `client`
   is relay-stamped and therefore optional in the schema, so an *unstamped*
   open still reaches the daemon and is refused there. That is precisely the
   lying-relay case ADR-018 exists for, so the check is a fail-closed edge
   guard, not a leftover. e2e asserts the relay-side rejection of a missing
   `epk`; the unstamped-`client` path is unasserted.

#### Library review (required by §1 before adopting a schema library)

An independent survey of zod v4, zod mini, valibot, superstruct,
`@sinclair/typebox` + Value, arktype, and `@exodus/schemasafe` against this
section's criteria concluded **hand-rolled**, and the implementation followed
it. The decisive points, not merely bundle size:

- Every candidate still leaves the security-critical work to us — pre-parse
  byte and depth bounds, canonical-form enforcement, a budgeted arbitrary-JSON
  walker, sealed-plaintext limits, direction checks, and non-reflective errors.
  The bespoke layer that remains is about the size of the whole core.
- Valibot, the closest fit on size, implements `strictObject` with `key in
  input`, so inherited names like `__proto__` and `constructor` are a review
  item rather than reliably-unknown own keys. Our `obj()` uses `Object.keys`
  and `hasOwnProperty`, so they are ordinary unknown keys and reject.
- Measured cost for a representative AgentPort schema: zod v4 ≈ 19.8 kB gzip,
  zod mini ≈ 5.4 kB, valibot ≈ 1.9 kB, superstruct ≈ 1.9 kB, arktype ≈ 44.6 kB.
  Any of these rides into third-party pages inside `connect.js` for combinators
  we would use a dozen of. The shipped layer — combinators, limits, all 40
  frame schemas, the canonical encoder, and the sealed-path checks — costs
  **3.0 kB gzip** in `connect.js` (34.1 → 37.2 kB, measured by building the
  bundle at HEAD and again with the change), less than the smallest library
  before any of the custom work it would still have required.
- Superstruct's default failure formatting prints the offending value, which
  directly conflicts with the no-reflection rule.

The same review's calibration note: comparable open protocols cluster at
64–128 KiB per durable event (Matrix caps a canonical event at 65,536 bytes;
strfry and nostr-rs-relay default to 131,072-byte payloads). Our 1 MiB frame
and 480 KiB plaintext are generous by comparison and justified only as an
exceptional envelope ceiling — which is why history is bounded and chunked and
oversized deltas are split rather than allowed to approach it.

Four defects the review found in the draft were fixed before commit: the
sealed-path `TextDecoder` was non-fatal (malformed UTF-8 became U+FFFD and
could defeat the canonical check downstream); `jsonValue` returned the parsed
input rather than a rebuilt value; `pattern()` accepted stateful `g`/`y`
regexes; and the aggregate tool-definition budget this section names had no
constant (`MAX_GRANT_CHARS`).

#### Review findings fixed before commit

Two independent reviews of the implementation (validation core; sealed-path
failure classification and adoption) found nine defects. All were fixed and
each now has a check that fails if it returns.

High:

1. **A forged nonce could end any observable session.** `decrypt()` compares
   the nonce *before* verifying the AEAD tag, and the draft classified a
   future-or-unparseable nonce as a `WireViolation` — which both endpoints
   treat as proof of peer misbehaviour. An on-path observer holding no key
   could therefore tear down any session it could see. All nonce mismatches
   are now `NonceMismatchError`: droppable, channel state untouched. A truly
   skipped frame stalls the session instead of killing it, which is the
   recoverable failure. `wire:check` asserts future, past, and malformed
   nonces are all droppable and that the authentic frame still opens after.
2. **Unbounded relay state from valid messages** (open sessions, pending
   resumes, pairing and connect entries). Pending resumes are now cleaned on
   socket close, and denied sessions release their routing entry. The
   remaining quotas and sweeps are §2 scope, recorded as open above.

Medium:

3. **`seal()` would encrypt a frame the receiver must reject.** A runtime's
   oversized string or a text split through a surrogate pair advanced both
   counters and then killed the peer's session. `seal()` now runs the
   receiver's own `decodeFrame` before `encrypt()`, so a local bug fails at
   its source. Text splitting no longer cuts between surrogates.
4. **Authenticated non-UTF-8 was dropped rather than fatal** — the fatal
   `TextDecoder` threw a `TypeError`, which read as a decrypt failure. It is
   now a `WireViolation`, matching the rule: post-authentication garbage is
   the peer's doing.
5. **The `missed` counter could exceed its wire bound**, making a long
   detachment produce a `session.resumed` the daemon could not legally send —
   a session that could never be resumed. It now saturates.
6. **Sparse arrays bypassed validation.** `.map()` skips holes, so a hole
   escaped the item schema and changed the encoded length. Both `arr()` and
   `jsonValue()` now walk indices and reject missing ones.
7. **Individually-legal fields could sum past the frame bound** (eight maximal
   history entries exceed `MAX_FRAME_CHARS`). `encodeFrame` now enforces the
   bound at the single point where a frame becomes bytes — a length compare on
   a string it already built — so no component can emit a frame its peer is
   obliged to reject.

Low: `-0` is rejected by `int()` and inside embedded JSON (it is a safe integer
that canonicalizes to `0`, so accepting it would validate a value that does not
round-trip); `hex(0)` accepts the empty string; and the pre-parse depth scan
stops on a closer at depth zero instead of letting the counter go negative and
buy headroom.

One reported item is intended behavior rather than a defect: an own property
whose value is `undefined` counts as absent, because `canonicalJson` drops it.
The round-trip invariant is therefore defined over the validator's rebuilt
result, not over the object a caller happened to pass in.
