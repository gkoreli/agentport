# ADR-025: A page is not a wallet — misuse-resistant APIs and enforceable custody

- **Status:** proposed; no implementation has landed
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
`AgentDaemon#trustedSurfaces`
(`packages/daemon/src/daemon.ts#trustedSurfaces`): a direct-key client is
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

## Decision

This ADR decides both the developer-facing boundary and the security boundary.
Packaging is a misuse control, not a cryptographic control. Attachment policy
is a containment control, not proof that an exportable root key remained
secret. Production custody ultimately requires a signer a third-party page
cannot obtain.

### R1. `AgentPort.connect()` is the only app-builder session-opening API

An ordinary website declares its surface and calls `AgentPort.connect()` from
a user gesture. It never constructs a wallet, supplies a root key, signs a
certificate, chooses an ownership identity, or talks to pairing frames.

The app-builder surface includes only:

- surface metadata and site tools;
- grant and per-site-tool approval hints;
- session prompting, events, cancellation, resume, and close; and
- semantic errors that distinguish relay reachability, user refusal, policy
  refusal, and session loss.

Changing the relay remains supported through `connect.js` configuration. A
self-hosted relay may legitimately live at `/`, so the library must not repair
URLs by guessing that every relay needs `/relay`. The hosted AgentPort example
must provide the exact production URL and fail visibly when it is wrong.

### R2. Wallet construction moves out of the default client package surface

`AgentWallet`, `WalletOptions`, pairing/certificate operations, provider
installation, and root-key socket authentication move to a separately named
privileged package or entry point. The intended name is
`@agentport/wallet-core`; settling the package name is not allowed to weaken
the boundary.

`@agentport/client` becomes the app-safe session and tool contract. Importing
`AgentWallet` from its root becomes a type error. All first-party custody code
— the extension, hosted wallet, and the implementation behind `connect.js` —
moves to the privileged package in the same change. The old root export is
deleted; there is no deprecated alias or compatibility export.

The privileged package documentation begins with the trust assumption: code
using it is implementing a wallet or AgentPort-owned attachment adapter, and
must not run with a persistent user secret in a third-party page.

This ruling makes accidental misuse harder and reviewable. It does not stop a
determined app from importing wallet internals, copying source, or implementing
the wire itself, and no security claim may rely on it doing so.

### R3. The local demo may demonstrate custody, but not disguise it as app code

The minimal example remains useful only if it shows the architecture it is
teaching. Its site and wallet roles must be separate modules or separate
origins, and the site half must consume the same `AgentPort.connect()` contract
recommended to external builders.

If an in-page development wallet remains, it is an explicit development
fixture imported from the privileged package. It uses the same delegation
path as production rather than opening a direct-owner attachment. It must not
persist a root key under the site's origin in a build presented as deployable.

The production demo, app-builder guide, and README must contain no direct
`AgentWallet` construction. A clean-browser "arrive as a stranger" review
must copy only the documented app-builder snippet and reach a working consent
surface without learning a wallet API.

### R4. A user root key is control-plane authority, not an attachment identity

Browser site attachments use fresh attachment keys. The user root key may
authorize an attachment, manage owned agents, revoke authority, and authenticate
a wallet control channel; it is not used as the client identity of a website
session.

The current direct-owner `session.open` branch is removed for website
attachments. The supported attachment forms become:

| attachment | session key | authorization | user-authority destination |
|---|---|---|---|
| extension-backed site | fresh attachment key | origin/grant-bound wallet authorization | extension control surface |
| hosted-wallet site | fresh attachment key | origin/grant-bound delegation | none after popup closes; refuse capabilities that need it |
| code flow | fresh authority-free key | daemon's local connect decision | daemon handlers actually installed for that capability |

The extension is not exempt merely because its current service worker safely
holds the user key. Separating its attachment key from its root key limits key
reuse, makes the wire express the same roles in every browser tier, and removes
"no delegation means trusted UI" as a policy shortcut.

A page that has already stolen or been deliberately given an exportable root
key can still sign any authorization that root key is empowered to sign. R4
does not pretend otherwise. It reduces the authority of ordinary attachment
keys and removes a protocol path that turns root possession directly into a
trusted application session.

### R5. User decisions travel on an authenticated control path, never by inference

The daemon must not infer a trusted approval or elicitation surface from the
absence of a delegation. `AgentDaemon#trustedSurfaces` is replaced by policy
derived from actual destinations:

- a `site_tool` decision may return from the site attachment because it is the
  site's own capability and remains bounded by the signed grant;
- a `runtime_own_tool` decision may return only from an authenticated user
  control channel or a daemon-local approval handler;
- an elicitation answer may return only from an authenticated user control
  channel or a daemon-local question handler; and
- when the required destination does not exist, the capability is refused in
  `session.opened`/`session.resumed`, logged, and rendered to the user.

The code that advertises each capability must be the code that can route to
its destination, preserving ADR-024 R12. A signed boolean claiming that a
surface exists is insufficient. The acceptance check must observe where the
request and answer actually travelled.

For an extension-backed attachment, the extension's service worker maintains
or brokers the user control channel and renders in extension chrome. The page
attachment cannot originate control answers. For the hosted-wallet tier, a
popup that has closed is not a control channel; capabilities requiring one
remain unavailable until a real, non-clickjackable destination exists. The
code flow continues to use daemon handlers and advertises only the handlers
the embedder installed.

### R6. Production root signing must become unavailable to third-party page JavaScript

An exportable Ed25519 key in `localStorage` cannot prove custody. Package
boundaries reduce accidental exposure, and origin isolation reduces who can
read a hosted-wallet key, but XSS or a compromised dependency on that origin
still obtains it.

The production custody destination is a non-exportable, user-mediated signer:

- a passkey/WebAuthn-backed key whose use is bound to the wallet's relying
  party and user-verification policy; or
- a NIP-46-style remote signer/bunker whose policy binds the operation,
  requester, origin, expiry, and user gesture where required.

Raw-key custody remains an explicitly transitional tier. It must not be used
as evidence that the caller is extension chrome or the wallet origin. General
availability cannot claim that arbitrary page-held roots are contained until
one of the non-exportable or remote-signing designs is implemented and its
recovery/revocation story is accepted.

This is the limit no amount of E2EE changes: encryption can keep a secret from
the relay; it cannot keep a secret from JavaScript to which the secret was
given.

### R7. State the E2EE endpoint precisely

Documentation and UI must say that session content is encrypted between the
active client attachment and the daemon. On an ordinary integration, the site
tab is intentionally the application-side plaintext consumer. The claim is
that the relay, network observer, and unrelated origins cannot read the
content—not that the website receiving agent output cannot read it.

The custody claim is separate: the page receives an ephemeral attachment key
and bounded authorization, while the root user key remains in the wallet,
extension, daemon-adjacent signer, or bunker. Neither claim may be used as a
shorthand for the other.

### R8. Ship as a protocol boundary, with no direct-owner compatibility path

R4 and R5 change session authorization and answer routing, so the relay,
daemon, wallet, extension, `connect.js`, and examples deploy together under a
new protocol version. The old direct-owner website session path is deleted in
the same change.

Control-plane operations that still authenticate with the user root key are
enumerated explicitly. A frame missing from that set is denied. Session
opening is not reintroduced as a fallback when a control channel or delegation
is unavailable; the user receives a visible refusal naming the missing
surface.

## Acceptance evidence

The two defects have separate evidence because one suite cannot prove the
other.

### Misuse-resistance evidence

1. A fixture importing `AgentWallet` or `WalletOptions` from
   `@agentport/client` fails to typecheck for that reason.
2. Reverting the export split makes that fixture compile; the observed failure
   is recorded before the check is accepted.
3. Every first-party production website uses `AgentPort.connect()` as its
   app-facing call. Privileged imports are confined to an explicit custody
   allowlist reviewed as a trust-boundary change.
4. The README and app-builder guide can be followed from a clean browser
   without copying a root key, wallet constructor, certificate call, or pairing
   implementation into the site.
5. The local example labels and visually separates its development wallet,
   while its site half uses the production app-builder contract.

These checks prove that our API and repository resist accidental misuse. They
do not prove that third-party JavaScript cannot reimplement the protocol.

### Security evidence

1. A valid owner key and certificate attempting the removed direct-owner
   website `session.open` path is refused over a real socket with a stable
   reason and deadline.
2. Extension and hosted-wallet attachments use fresh session identities and
   authorization bound to the exact origin, agent, grant, expiry, and
   attachment key. Replays across any one of those fields fail at both relay
   and daemon where each has authoritative evidence.
3. A delegated page cannot originate a `runtime_own_tool` approval or an
   elicitation answer. Forged answers are refused, logged, and settle the
   waiting operation rather than hanging it.
4. Extension-backed runtime approvals and elicitation answers are observed
   travelling through the authenticated extension control path. Removing that
   route makes the capability disappear from the attachment instead of
   rerouting it to the page.
5. Code-flow capabilities are advertised only when the corresponding daemon
   handler exists. Removing either handler makes the precise policy assertion
   fail.
6. The relay remains unable to decrypt prompts, output, tool calls/results,
   approvals, or elicitation in every surviving attachment tier.
7. Root-key compromise is recorded as a blocking residual risk until the
   selected non-exportable or remote signer is exercised end to end. No green
   check may claim to prove where an exportable key was stored or which browser
   execution context used it.

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

### Treat every direct-key client as trusted because compromise is already total

This accurately describes the consequence of root compromise and turns it
into the attachment architecture. It also couples trusted-answer routing to a
negative wire fact—no delegation—instead of to the surface that receives the
question. ADR-024 already records the cost of that shape.

### Ban low-level wallet code from being published

Alternative wallets, self-hosted custody, the extension, and the hosted wallet
need a shared implementation. Hiding it in the repository would create copied
parallel implementations that drift. The right boundary is an explicit
privileged package consumed by every wallet implementation, not no package.

## Consequences

- The ordinary integration becomes smaller: one script, one connect call, and
  site tools. A builder cannot accidentally persist a root key using the
  default client export.
- Wallet authors receive a more explicit but less convenient package whose
  name and documentation require them to acknowledge custody responsibility.
- Extension attachments become slightly more complex because attachment data
  and user-control answers are separate channels. That complexity represents
  a real trust boundary currently compressed into `AgentWallet`.
- Hosted-wallet attachments remain deliberately diminished for runtime-owned
  tools and elicitation when no trusted answer surface remains open. The UI
  must say so.
- A protocol version bump and lockstep deployment are required. There is no
  compatibility path for direct-owner website sessions.
- Passkey or remote-signer custody remains required. Until it lands, an
  exportable root-key compromise is terminal for the authority that key owns,
  and the product must say that plainly.

## Open implementation choices

The rulings above do not depend on these choices, which require focused design
before implementation:

1. Whether the privileged package is named `@agentport/wallet-core` or exposed
   as an equally explicit non-root subpath. A separate package is preferred
   because package ownership and dependency review then follow the trust
   boundary.
2. Whether the extension control path is a second relay role, a sealed channel
   multiplexed over its existing socket, or a daemon-addressed approval
   endpoint. It must authenticate the user controller independently of the
   page attachment and preserve the relay-blind content property.
3. Whether passkeys directly become the user signing key or unlock/wrap an
   Ed25519 key used for protocol compatibility. The answer must cover backup,
   recovery, multi-device use, revocation, and headless/self-hosted operation.
4. How a wallet proves browser-observed origin to a non-browser daemon without
   turning a wallet-authored string into universal browser attestation. The
   current hosted-wallet delegation binds `MessageEvent.origin`; the accepted
   design must state exactly which component observed each value and what a
   compromised root signer can still forge.
