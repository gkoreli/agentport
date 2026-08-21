# ADR-025: A page is not a wallet — misuse-resistant APIs and enforceable custody

- **Status:** proposed; three independent Sol reviews integrated. The narrow
  identity-bound resume prerequisite from R4 and its attachment-lifetime
  enforcement landed on 2026-08-08 in protocol v6; the package split,
  authorization replacement, controller proofs, and root-custody work remain
  unimplemented.
- **Date:** 2026-08-08
- **Owners:** AgentPort maintainers
- **Depends on:** ADR-003 (end-to-end sealing), ADR-008 (wallet tiers),
  ADR-009 (extension custody), ADR-018 (security architecture), ADR-019 Gate B
  (production custody), ADR-023 (approval authority), ADR-024 (trusted answer
  surfaces)
- **Would supersede in part:** ADR-024's rule that a direct-key attachment is
  sufficient evidence of a trusted answer surface

## Context

On 2026-08-08 an external app integration failed because it constructed
`AgentWallet` directly with a relay URL missing `/relay`. The availability bug
was one character-level configuration error. The published bundle exposed the
more important fact: the app had copied the local demo's custody shape and
stored `agentport.dev.userkey` in its own origin's `localStorage`.

The app did not have to fight the library to get there. `AgentWallet`
(`packages/client/src/wallet.ts#AgentWallet`) is exported from the root of
`@agentport/client`; `WalletOptions`
(`packages/client/src/wallet.ts#WalletOptions`) asks directly for
`userSecretKey`; and the minimal example deliberately combines `[WALLET]` and
`[SITE]` in one file (`examples/inkwell/src/app.ts#devUserKey`). The comments
say that arrangement is development-only, but the type system, package
boundary, and runtime all accept it as an ordinary integration.

The supported app-builder path is already different. `AgentPort.connect()`
chooses the extension, hosted-wallet delegation, or daemon-approved code flow.
In the hosted tier, `connectWithHostedWallet`
(`site/src/connect.ts#connectWithHostedWallet`) creates a fresh attachment key
and receives an origin- and grant-bound delegation. The page does not receive
the user's root key. The API with the correct custody boundary and the API that
bypasses it are both easy to reach, and the lower-level one looks complete
enough to build a product on.

This exposes two different defects. They need different remedies.

### Defect A: misuse is the path of least resistance

An app builder needs tools, a session, prompts, events, and a close operation.
It does not need pairing, certificate issuance, ownership storage, revocation,
or a root signing key. Yet the default client barrel gives it all of those.

Documentation cannot carry this boundary by itself. The external app was a
reasonable copy of a working example and compiled without resistance. A
security comment is least effective at exactly the moment it matters: when a
builder copies an API from code rather than reading the architecture around
it.

This is an API-design failure even if every protocol check works perfectly.
The safe path must be smaller and easier than the privileged path, and the
privileged path must name the trust it assumes.

### Defect B: E2EE does not prove endpoint custody

AgentPort's end-to-end encryption is working as designed. It protects session
content from the relay and network observers. It does not protect plaintext or
keys from either endpoint, and it cannot tell whether JavaScript holding a
valid Ed25519 secret is an extension service worker, a wallet-origin app, a
local demo, or an arbitrary site.

If a page holds the user root key, cryptography identifies that page as the
user. It may sign ownership certificates, delegations, challenge responses,
and any future assertion the same key is allowed to sign. Neither the relay
nor the daemon can infer where the signing operation ran. Adding a field named
`trusted`, `wallet`, or `custody` would add a self-assertion, not evidence.

ADR-024 currently acknowledges this limit in
`AgentDaemon#consentRouting`
(`packages/daemon/src/daemon.ts#consentRouting`): a direct-key client is
treated as trusted because a page holding the root key can already mint any
authority. That observation is correct about a compromised root key and wrong
as a production attachment design. "The escalation already happened" is a
reason to prevent and contain the escalation, not a reason to make direct-key
attachments the normal trusted tier.

The two defects meet at one boundary:

```text
                         user authority / control
                   extension, wallet origin, daemon
                                  |
                         bounded authorization
                                  v
site page  <======= sealed attachment =======>  agent daemon
ephemeral key                                   device key
```

The page is intentionally a plaintext endpoint for the prompts, output, and
site tools delivered to that tab. It must not also become the user's durable
authority endpoint merely because both responsibilities currently fit in one
class.

### Prerequisite found during review: resume could change the E2EE endpoint

Reviewing this boundary exposed an older defect that had to be fixed before a
second authority path could be built. `session.opened` sent its resume token as
visible lifecycle metadata, so a malicious relay knew it. The pre-fix
`AgentDaemon#onSessionResume`
(`packages/daemon/src/daemon.ts#onSessionResume`) checked that bearer token and
verified the fresh X25519 key against the *new* relay-stamped Ed25519 client,
but did not require that client to equal the attachment's stored `clientKey`.
It then overwrote `clientKey` with the new value.

A malicious relay could therefore observe a legitimate token, force a detach,
generate its own Ed25519 and X25519 keys, resume as the new client, and become
the application-side plaintext endpoint. The retained attachment policy came
with it. The resume-theft checks at that time did not cover that adversary:
they tested a socket without the token or a thief while the original
attachment was still live, while the relay had the token and could manufacture
the detach.

That bearer-only endpoint transfer is closed in protocol v6. Resume now
requires the visible token plus a fresh EPK proof by the original bounded
Ed25519 attachment identity; the daemon never replaces that identity from a
resumer. The version is itself signed into every EPK proof transcript, so the
relay cannot split-negotiate an older versionless proof with one endpoint. A
control design can now build on stable attachment identity without inheriting
the takeover.

## Decision

This ADR decides both the developer-facing boundary and the security boundary.
Packaging is a misuse control, not a cryptographic control. Attachment policy
is a containment control, not proof that an exportable root key remained
secret. Production custody ultimately requires a signer a third-party page
cannot obtain.

### R1. `AgentPort.connect()` is the sole supported cross-wallet entry

An ordinary website declares its surface and calls `AgentPort.connect()` from
a user gesture. It never constructs a wallet, supplies a root key, signs a
certificate, chooses an ownership identity, or talks to pairing frames.

`navigator.agent.connect()` remains the installed-provider contract behind
that discovery path, not the call an app writes. `AgentPort.resume()` is the
one recovery operation for an already-authorized logical attachment, not a
second way to create one. The classic-script global exposes exactly
`connect()` and `resume()` (plus an explicitly selected version field if one is
needed); the current `provider` and `getProvider` escape hatches are removed.

The app-builder surface includes only:

- surface metadata and site tools;
- grant and per-site-tool approval hints;
- session prompting, events, cancellation, resume, and close; and
- semantic errors that distinguish relay reachability, user refusal, policy
  refusal, and session loss.

Those errors use one closed public code union shared by the drop-in and
extension bridge. Plain `Error` strings and a second private
`ProviderRejected` type are not a public contract.

Changing the relay remains supported through `connect.js` configuration. A
self-hosted relay may legitimately live at `/`, so the library must not repair
URLs by guessing that every relay needs `/relay`. The hosted AgentPort example
must provide the exact production URL and fail visibly when it is wrong.

### R2. Split the current client by authority, not only by package name

Moving today's `AgentWallet` unchanged to `@agentport/wallet-core` would keep
the defect inside `connect.js`. The class currently combines root
authentication, directory and pairing operations, certificate issuance,
revocation, direct-owner opening, delegated and code-flow attachments,
sealing, resume, and concrete session construction. The page bundle needs only
the attachment part.

The implementation is split into three layers:

| layer | contains | must not contain |
|---|---|---|
| public app contract (`@agentport/client`) | connect request, session handle/events, site tools, stable public errors | sockets, secret keys, pairing, certs, revocation, concrete session opening |
| private attachment core (`@agentport/attachment`) | attachment authorization, sealed transport, grant construction, concrete session, identity-bound resume, code flow | root signing, owned-agent directory, pairing, certificate issuance, revocation |
| private wallet core (`@agentport/wallet-core`) | signer abstraction, owned-agent directory, pairing/certs, revocation, attachment/controller authorization | site application API or site tool implementation |

`connect.js` depends on the public contract and attachment core, never wallet
core. The hosted wallet depends on wallet core. The extension service worker
depends on wallet core and attachment core; its page-world provider depends
only on public/provider contracts. Both internal packages begin `private: true`
until their own clean-install, versioning, compatibility, and publication
contract is accepted. Renaming a workspace package must not imply a published
API that the release process does not ship.

`AgentWallet`, `WalletOptions`, root socket exports, and
`createWalletProvider` disappear rather than moving intact. `installProvider`
contains no key authority; it lives in an explicit provider-author subpath and
is dogfooded by the extension's page-world injection instead of keeping the
extension's current hand-written parallel provider installation.

Importing wallet or attachment machinery from the default client root becomes
a type error. All first-party consumers move in the same change, and the old
exports are deleted with no deprecated aliases. This makes accidental misuse
harder and the authority graph reviewable. It does not stop a determined app
from copying source or implementing the wire, and no security claim relies on
it doing so.

### R3. The local demo may demonstrate custody, but not disguise it as app code

The minimal example remains useful only if it shows the architecture it is
teaching. A custody demonstration puts its wallet on a separate origin,
extension context, daemon surface, or other independently protected signer.
Separate modules on the same origin are organization, not isolation: they can
read the same storage and call one another. The site half consumes the emitted
classic `connect.js` and the same `AgentPort.connect()` contract recommended to
external builders.

If an in-page development wallet remains, it is labelled an unsafe protocol
fixture, uses no persistent root key, and is never presented as deployable or
as evidence of custody. Exercising delegation in a second same-origin module
proves the protocol shape and nothing about key custody.

The production demo, app-builder guide, and README must contain no direct
`AgentWallet` construction. A clean-browser "arrive as a stranger" review
must copy only the documented app-builder snippet and reach a working consent
surface without learning a wallet API. At least one deployed first-party
surface loads the emitted `/connect.js`; bundling `site/src/connect.ts` into a
different ESM artifact is not dogfooding the thing a stranger receives.

### R4. A user root key is control-plane authority, not an attachment identity

**Implemented prerequisite (2026-08-08):** today's existing attachment
identity is now immutable across resume. The daemon requires the original
Ed25519 client's proof as well as the relay-visible token, the hosted/demo page
persists only that bounded client secret beside the token in per-tab storage,
and no bearer-only legacy record is accepted. Every EPK proof signs protocol
v6 as part of its transcript. A fresh wallet retains the authenticated token
after a successful resume and can therefore rekey the same handle after a
second socket loss. The daemon enforces the minimum of grant and delegation
expiry throughout live traffic—including prompt admission, tool dispatch on
both sides of approval, and late results—and authenticated `revoked` denials
clear page and extension resume records. This closes the malicious-relay
handoff and the lifetime gaps without claiming the broader
`SessionAuthorization` or controller design below has landed.

Owner authentication alone is not attachment authorization. Except for the
separately justified relay-synthesized code flow, every website
`session.open` requires a bounded root-signed `SessionAuthorization` (the
replacement for today's `SessionDelegation`) naming:

- one Ed25519 attachment identity distinct from the user root;
- one target agent and wallet-observed origin;
- the exact grant hash, issuance time, and expiry;
- optionally, one distinct controller public key and its exact decision and
  question rights.

The Ed25519 attachment identity is stable for the logical attachment. X25519
sealing keys remain ephemeral and fresh on every open or resume. The client
EPK proof binds the complete authorization or its domain-separated digest, so
a relay cannot substitute another valid authorization with different control
rights.

Resume requires both the bearer token and proof by the stored attachment
identity. `AgentDaemon#onSessionResume` compares the relay-stamped client with
the session's existing `clientKey` and never overwrites it from an arbitrary
resumer. The page or extension persists the bounded attachment secret beside
its resume authority; it never persists the user root there. Authorization
expiry bounds the whole resumable attachment, not only its first open.

The supported forms become:

| attachment | Ed25519 identity | authorization | user-authority destination |
|---|---|---|---|
| extension-backed site | fresh bounded attachment key | root-signed origin/grant authorization with controller key and separate rights | extension chrome, proven by controller signatures |
| hosted-wallet site | fresh bounded attachment key | root-signed origin/grant authorization with no controller rights | none after popup closes; refuse capabilities that need it |
| code flow | fresh authority-free key | daemon's EPK-specific local connect decision | daemon handlers actually installed for that capability |

The extension is not exempt merely because its service worker currently holds
the root key. Separating root, attachment, controller, and X25519 roles limits
key reuse and removes "no delegation means trusted UI" as a policy shortcut.

A page that stole or was deliberately given an exportable root can still mint
a valid attachment and controller authorization. Removing direct-owner open is
least-authority containment for ordinary attachment keys, not attestation of
where the root ran. Acceptance evidence demonstrates this residual power with
a positive root-signed authorization test instead of hiding it.

### R5. User decisions require independent controller authority, not inference

A second relay channel is not required for the first coherent design. The
extension keeps one end-to-end sealed attachment channel, but holds a
controller key distinct from the attachment key. `runtime_own_tool` approvals
and elicitation answers carry controller signatures inside ciphertext. The
relay cannot read them, and possession of the attachment key alone cannot
forge them.

Controller proofs bind the session, pending request id, authority domain or
canonical question digest, call hash where one exists, the decision or answer,
and an anti-replay value. The daemon verifies the controller and its exact
rights from `SessionAuthorization` before settling the pending operation.
Cross-request, cross-session, and cross-domain reuse fails.

The routing rules are:

- a `site_tool` decision may return from the site attachment because it is the
  site's own capability and remains bounded by the signed grant;
- a `runtime_own_tool` decision may return only with a valid controller proof
  or from a daemon-local approval handler;
- an elicitation answer may return only with a valid controller proof or from
  a daemon-local question handler; and
- absent authority is reported independently as `mayUseOwnTools: false` or
  `mayAsk: false` in `session.opened`/`session.resumed`, authenticated by the
  agent's EPK proof, logged, and rendered to the user.

A forged page answer is refused and logged; it does **not** settle or cancel a
legitimate controller request, because that would give the page a veto. The
request settles only through a valid controller/local answer, abort, session
close, controller loss, or its own bounded deadline. Approval gets a deadline
as elicitation already does; neither path may wait forever.

The code that advertises each capability is the code that has installed its
real destination, preserving ADR-024 R12. The extension service worker that
installs extension-chrome handlers is the code that requests controller
rights, and real-browser evidence observes the request reach that window. A
signed rights bit alone is not evidence that honest UI was used. Hosted-wallet
authorizations omit controller rights after the popup closes. Code flow derives
each field directly from its installed daemon handler.

A separate sealed controller channel remains a future option for a controller
on another device or for hiding control requests from the attachment endpoint.
It is not necessary for attachment-key separation and is not sufficient to
solve exportable-root compromise, so this ADR does not require it.

### R6. Production root signing must become unavailable to third-party page JavaScript

An exportable Ed25519 key in `localStorage` cannot prove custody. Package
boundaries reduce accidental exposure, and origin isolation reduces who can
read a hosted-wallet key, but XSS or a compromised dependency on that origin
still obtains it.

The production custody destination is a non-exportable, user-mediated signer.
Two designs remain viable and neither is the current raw-key API:

- A WebAuthn credential supplies a protocol-verifiable WebAuthn proof or
  authorizes a bounded wallet-device/controller credential. WebAuthn does not
  sign arbitrary AgentPort canonical bodies, so this requires a new proof
  format. Using a passkey merely to unwrap Ed25519 material is only at-rest
  protection; once JavaScript reconstructs the raw key, same-origin compromise
  can export it.
- A NIP-46-style remote signer/bunker retains the root elsewhere and enforces
  operation, requester, origin, agent, grant, expiry, and user-interaction
  policy rather than acting as an unrestricted signing oracle.

Raw-key custody remains an explicitly transitional tier. It must not be used
as evidence that the caller is extension chrome or the wallet origin. General
availability cannot claim that arbitrary page-held roots are contained until
one of the non-exportable or remote-signing designs is implemented and its
recovery/revocation story is accepted. Today both the hosted wallet's
`localStorage` key and the extension's `chrome.storage.local` key are
exportable; origin/process isolation makes the latter safer from a hostile
site, not non-exportable.

This is the limit no amount of E2EE changes: encryption can keep a secret from
the relay; it cannot keep a secret from JavaScript to which the secret was
given.

### R7. State the E2EE endpoint precisely

Documentation and UI state the endpoint for each tier:

- extension: the extension service-worker attachment adapter and daemon;
- hosted-wallet and code-flow page attachments: the site tab and daemon; and
- daemon-local approval or elicitation: the daemon handler and runtime.

On an ordinary page attachment, the site tab is intentionally the
application-side plaintext consumer. The claim is that the relay, network
observer, and unrelated origins cannot read the content—not that the website
receiving agent output cannot read it. Controller proofs travel inside the
same sealed content and do not make the page blind to data intentionally
delivered to its attachment endpoint.

The custody claim is separate: the page receives an ephemeral attachment key
and bounded authorization, while the root user key remains in the wallet,
extension, daemon-adjacent signer, or bunker. Neither claim may be used as a
shorthand for the other. Resume now preserves today's attachment identity and
no longer accepts the bearer token as transferable endpoint authority. The
broader R4 custody claim still awaits complete bounded authorization and
separate root/controller identities.

### R8. Deliver two gates; the wire gate has no direct-owner compatibility path

The defects are independent enough to close in two gates and coupled enough
that each gate must delete what it replaces.

**Gate A — misuse boundary, no wire change.** Split the public contract,
attachment core, and wallet core; remove privileged root exports and the
combined `AgentWallet`; standardize public errors; reduce the classic global;
migrate every first-party consumer; make the extension use the shared provider
installer; and dogfood the emitted `/connect.js`. Gate A ships without waiting
for controller or signer protocol work.

**Gate B — custody protocol.** Its identity-bound resume prerequisite has
landed using the existing frame fields in protocol v6. The required semantics
are part of the version and the version is signed into every EPK proof. In one
later protocol version, replace
delegation with complete attachment/controller authorization, bind it
into both handshake proofs, authenticate `mayUseOwnTools` and `mayAsk`, add
bounded controller proofs and deadlines, and delete the direct-owner website
open branches at both relay and daemon. Every positive direct-owner fixture is
replaced; direct owner remains only as a hostile negative case.

Root-authenticated control-plane operations are enumerated explicitly:
directory access, pairing/certificate issuance, revocation, and attachment or
controller authorization. A frame missing from that set is denied.
`session.open` is not in it. Missing controller authority is never repaired by
rerouting to the page.

Protocol v6 is a hard coordinated cutover: the hosted relay, site and wallet
artifacts, daemon CLI, and extension endpoint change as one release boundary.
There is no v5 parser, proof fallback, heuristic endpoint path, or retained
v5 session; existing live and resumable sessions end at cutover.

The release workflow fails a wire change without a new CLI version, builds the
site and wallet plus every separately typechecked browser/extension/example
target before tagging, and exercises the exact packed CLI artifact against
production. `packages/cli/build.ts#buildRemoteCheck` bundles the smoke into the
CLI tarball, and CI extracts that saved artifact rather than importing daemon
source from the checkout. A manual `deploy: false` retry still runs this exact
artifact's production proof, and npm remains locked behind its successful
deploy job. Manual extension distribution remains an explicit availability
gap, not a reason to retain the old protocol.

## Acceptance evidence

The two defects have separate evidence because one suite cannot prove the
other.

### Misuse-resistance evidence

1. A non-empty structural export assertion proves `AgentWallet` and
   `WalletOptions` are absent from `keyof typeof import('@agentport/client')`.
   A separate negative-compile fixture checks the exact missing-export
   diagnostic. Restoring either export makes the structural guard fail and the
   negative fixture unexpectedly compile; missing packages or unrelated
   module-resolution errors are not accepted.
2. Real esbuild metafiles prove `connect.js`, the extension page-world bundle,
   and its content bundle contain no wallet-core input. The hosted wallet and
   extension service worker are the only browser graphs allowed to contain it.
   Adding one value import to `site/src/connect.ts` makes the check name that
   forbidden graph edge.
3. The classic-script VM check asserts the exact `AgentPort` global and stable
   public error union. Restoring `provider`, `getProvider`, or a private error
   dialect fails at the public boundary rather than during a later relay call.
4. Privileged imports are confined to a source/package allowlist reviewed as a
   trust-boundary change. This check is deliberately string-keyed and is
   described as such; moving an import fails closed until its new owner is
   reviewed.
5. A deployed first-party surface is observed requesting `/connect.js` and
   invoking its global from the connect button. Its ESM bundle excludes
   `site/src/connect.ts`. Removing the script and re-importing the source fail
   for different, intended reasons.
6. The README and app-builder guide work from a clean browser without copying
   a root key, wallet constructor, certificate call, or pairing implementation
   into the site. Whether the path is understandable remains a human stranger
   walk, not a green source assertion.
7. A custody demo uses a separate origin/context and proves the site cannot
   read wallet storage. Any same-origin fixture is labelled unsafe and proves
   protocol behavior only. Visual honesty remains a recorded human review.

These checks prove that our API and repository resist accidental misuse. They
do not prove that third-party JavaScript cannot reimplement the protocol.

### Security evidence

1. **Implemented prerequisite evidence.** A malicious-relay harness records a
   legitimate visible resume token, forces detach, and attempts resume with its
   own valid Ed25519/X25519 keys. The daemon refuses it within a deadline, does
   not change `clientKey`, and the legitimate attachment identity subsequently
   resumes. Restoring the old resumer-selected proof identity makes this exact
   attack become the plaintext endpoint. The full R4 authorization/controller
   evidence remains part of Gate B.
2. A valid owner key and certificate attempting direct-owner website
   `session.open` is refused independently by the real relay and by the real
   daemon behind a lying-relay fixture, each with a closed denial reason and
   deadline. Restoring either branch breaks only its edge-specific check.
3. A companion positive check proves the same exportable root can mint a valid
   bounded authorization and open through it. That is recorded residual root
   authority, not a security failure or custody proof.
4. Authorization replay fails when changing attachment Ed25519 identity,
   X25519 EPK, agent, wallet-observed origin, grant, issue/expiry time,
   controller identity, or either controller right. Relay and daemon checks
   are asserted only for facts each can authoritatively establish. Substituting
   one otherwise-valid authorization invalidates the handshake proof.
5. A page or stolen attachment key cannot forge a `runtime_own_tool` decision
   or elicitation answer without the controller key. Forged frames are refused
   and logged while a legitimate controller may still answer; with no valid
   answer, the request settles only through its deadline, abort, loss, or
   close.
6. A real-Chrome integration drives a local relay, daemon, scripted runtime,
   extension, and hostile page. It observes the request reach extension chrome,
   proves page callbacks/messages receive none of it, supplies the controller
   answer, then removes each handler and observes the corresponding capability
   disappear rather than reroute.
7. Code-flow capabilities are advertised only when the exact daemon handler
   exists. Removing `onLocalApproval` and `onLocalAsk` separately changes only
   the matching policy field and routing test.
8. The relay remains unable to decrypt canaries in prompts, output, tool
   calls/results, approvals, controller proofs, or elicitation across extension,
   hosted-wallet, and code tiers. Plaintext sabotage fails the tier-specific
   assertion.
9. `session.opened` and `session.resumed` authenticate and render both
   `mayUseOwnTools` and `mayAsk`. Collapsing them or omitting either from the
   agent proof fails the policy-specific test.
10. A release check rejects a new wire fingerprint/version without a new CLI
    version, and the post-deploy smoke runs the exact saved CLI tarball rather
    than imports from checkout source.
11. Root-key location, honest third-party wallet UI, absence of XSS/extension
    compromise, and human understanding remain explicitly unproven. No green
    automated check may claim to establish them.

Every new check is sabotaged once and its failure read before acceptance. A
failure in URL routing, frame decoding, or an unrelated type assertion is not
evidence for custody or answer routing.

## Alternatives rejected

### Rely on E2EE

E2EE begins after relay connection and terminates at the client attachment. It
neither repairs a wrong WebSocket URL nor protects a root key from the client
JavaScript holding it.

### Keep the API and improve the warning comment

That is the state that produced the incident. A warning adjacent to a complete,
easy-to-copy API loses to the API.

### Reject `AgentWallet` whenever `document` exists

The extension, hosted wallet, and page are all browser JavaScript. Environment
sniffing cannot establish custody and would either block legitimate wallets or
be trivial to bypass.

### Add `trusted: true` or `custody: "extension"` to the handshake

A page holding the signing key can sign or send the same value. A claim about
the execution environment is not attestation of that environment.

### Require a second relay channel before separating authority

A separate sealed controller channel is useful when the controller lives on
another device or its requests must be hidden from the attachment endpoint.
It adds association, sealing, reconnect, loss, resume, and multi-controller
state, while a root/controller compromise remains authoritative. Controller-
signed responses on the existing sealed channel give the daemon independent
answer authority with a smaller first cut. The route into extension chrome is
still proved by browser evidence, not by the signature alone.

### Keep bearer resume because the token is random

The relay observes the token and is an in-scope adversary. Randomness does not
help once the adversary has the value, and verifying a new EPK against a new
self-chosen Ed25519 key proves only self-consistency. Resume must prove the
stored attachment identity or a secret the relay never learns.

### Treat every direct-key client as trusted because compromise is already total

This accurately describes the consequence of root compromise and turns it
into the attachment architecture. It also couples trusted-answer routing to a
negative wire fact—no delegation—instead of to the surface that receives the
question. ADR-024 already records the cost of that shape.

### Ban low-level wallet code from being published

Alternative wallets, self-hosted custody, the extension, and the hosted wallet
need a shared implementation. Hiding it in the repository would create copied
parallel implementations that drift. The right boundary is shared attachment
and wallet cores with explicit owners. They stay workspace-private until their
own publication contract exists; hiding them is not the long-term security
property.

## Consequences

- The ordinary integration becomes smaller: one script, one connect call, and
  site tools. A builder cannot accidentally persist a root key using the
  default client export.
- Attachment and wallet code become separate implementations rather than one
  class with a safer name. `connect.js` loses pairing, cert, directory,
  revocation, and root-signing code it never needed.
- Wallet authors eventually receive an explicit package whose name and
  documentation require custody responsibility; it is not a supported npm
  artifact until clean-install and release evidence exist.
- Extension attachments gain separate attachment and controller identities,
  while continuing to use one sealed channel initially. That complexity
  represents a real authority boundary currently compressed into
  `AgentWallet`.
- Hosted-wallet attachments remain deliberately diminished for runtime-owned
  tools and elicitation when no trusted answer surface remains open. The UI
  must say so.
- Resume secrets now include a bounded attachment identity that survives a
  reload. Compromise of that identity loses the attachment, not the user root
  or controller authority.
- A protocol version bump and coordinated deployment are required. Protocol v6
  is a hard relay/endpoints cutover with no v5 fallback; old live and resumable
  sessions end.
- Passkey or remote-signer custody remains required. Until it lands, an
  exportable root-key compromise is terminal for the authority that key owns,
  and the product must say that plainly.

## Open implementation choices

The Sol review closed the package topology, resume identity, and first
controller topology. These choices remain and require focused design before
their corresponding work lands:

1. Whether WebAuthn directly supplies a new root proof format or authorizes a
   bounded wallet-device credential. The answer must cover backup, recovery,
   multi-device use, revocation, headless/self-hosted operation, and exactly
   what requires user verification.
2. Controller-key lifecycle inside the extension: generation, rotation,
   resume persistence, and loss. Controller rights never transfer merely
   because an attachment resume token did.
3. Whether a later cross-device controller needs a second sealed relay role.
   That is a new topology decision, not an implementation toggle on R5.

Origin evidence is not left ambiguous: the hosted wallet binds the browser's
`MessageEvent.origin`; the extension uses browser-provided sender metadata;
the code flow uses the daemon-approved surface. The daemon verifies that the
signed origin equals the opened surface. This is wallet-authorized origin, not
universal browser attestation, and a compromised root signer can forge it.
