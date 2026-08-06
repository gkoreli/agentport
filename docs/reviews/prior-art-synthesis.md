# Prior-art synthesis — what to consume, what to steal, what to build

- **Status:** research memo (2026-08-06)
- **Method:** six parallel deep reads of primary sources (specs, RFCs, repo
  source, issue trackers), each mapped onto AgentPort's roadmap. Raw cluster
  reports are summarized here; this document is the actionable distillation.
- **Companions:** `reviews/webmcp-conformance.md` (why the unqualified WebMCP
  claim is withdrawn), `reviews/web-harness-consent.md` (why remembered-write
  consent was cut from ADR-021), `ADR-021-web-harness.md`, `ADR-019-security-hardening.md`.

The question this answers: *given that the extension is our first real product
built on the AgentPort protocol, what has everyone adjacent already figured out
that we can either depend on or copy the shape of — so the product is much
better than what we'd invent alone?*

The clusters: **(1) capability/authorization**, **(2) browser harness**,
**(3) relay/rendezvous**, **(4) agent-protocol ecosystem**,
**(5) injection containment**, **(6) browser provider-picker primitives**.

---

## The one-paragraph verdict

Almost nothing here is a dependency we should take into
`@agentport/protocol` or `@agentport/client` — every serious candidate drags in
CBOR/protobuf/JSON-LD/zod stacks that violate the zero-dep, browser-safe,
ships-inside-`connect.js` constraint, and the two things we *do* already consume
well (ACP at the runtime edge, `@ag-ui/core` at the render edge) are consumed
because the dependency direction points away from `connect.js`. The value is in
**shapes to copy**, and the convergence is striking: independent systems in
authorization, wallets, browser agents, and payments have all arrived at the
same four ideas AgentPort's roadmap is reaching for — **an open grant that is a
signed, constraint-bounded, expiring object; per-execution receipts hash-bound
to that grant; a closed, renderable action-class vocabulary the trusted surface
enforces rather than the requester; and ephemeral element/session addressing
that is regenerated, never persisted.** Where AgentPort already does the right
thing (blind relay, ephemeral-per-attachment keys, consent at the key, grant
enforced at both edges) the prior art is independent validation. Where it
doesn't yet (remembered consent, revocation, the reverse firewall, the harness)
the prior art hands us the design nearly finished.

---

## Cross-cutting patterns (the things ≥3 clusters agree on)

1. **The grant should be a signed open object, and each use a hash-bound closed
   receipt.** AP2's open/closed mandate split (§4), UCAN/Biscuit/ZCAP delegation
   chains (§1), and GNAP's continuable grant (§1) are the same idea four times:
   remembered consent = a *user-signed open grant* carrying typed constraints
   and an expiry; each later execution = an *agent-signed closed record*
   cryptographically bound to the open grant. AgentPort's key layout is already
   homologous (`AgentCert`: user key signs agent device key ≈ AP2's `cnf`
   device-key binding). This upgrades "remembered consent" from a stored boolean
   to an auditable chain — and it is the single highest-value architectural
   steal in the whole sweep.

2. **The action-class vocabulary must be closed, renderable, and enforced by the
   consumer — with the requester's hints treated as untrusted claims.** MCP's
   annotation quartet, ACP's `ToolKind`, and WebMCP issue #198's
   `humanInTheLoopHint` ladder are all *advisory* by their own explicit words
   ("clients should never make tool use decisions based on `ToolAnnotations`
   received from untrusted servers" — MCP schema, verbatim). RAR (§1) proves the
   display side: `type/actions/locations` objects with request/grant symmetry,
   where the user may grant a subset. AgentPort's differentiator is precisely
   that its classes are *grant-enforced at the wallet/daemon* where every prior
   art disclaims enforcement. So: define the classes as a closed set, project
   MCP/ACP/WebMCP annotations onto them as *claims the wallet clamps*, and ship
   the renderer with the vocabulary (nobody else did, which is why their
   fine-grained consent decays to click-through).

3. **Cryptographic binding beats human vigilance, every time it was tested.**
   Every system that leaned on optional context or a person paying attention got
   exploited (device-code phishing/Storm-2372, `ssh-add -c`, CIBA without a
   binding message); every system that bound the decision to the request
   survived (FIDO hybrid's BLE proximity, CIBA number-matching, GNAP's finish
   `hash`, ssh `publickey-hostbound`). Direct consequence for AgentPort: **the
   approval frame must sign the exact tool-call it approves** (kills the TOCTOU
   where an approval for call X is applied to call X′), and the connect-code
   flow must bind code + both nonces + relay into the signed material.

4. **Ephemeral, regenerated addressing beats durable identifiers.** In the
   harness cluster, every project that tried durable element identity (XPath
   caches, bare integer indexes) is the one with a wrong-click issue tracker;
   the winners (Playwright refs, chrome-devtools uids) regenerate per snapshot
   and refuse stale refs loudly. This is the *same* principle as AgentPort's
   ephemeral-per-attachment keys and iroh's "dial keys, not IPs, relays are
   fungible" — identity/authority is short-lived and re-derived, never a stored
   fact a middle party could lie about.

5. **The industry converged on AgentPort's trust shape.** MCP is *deprecating
   Sampling* (a server borrowing the client's model) — the ecosystem concluded
   borrowing a model across a trust boundary doesn't work, which is AgentPort's
   "we never see a model" as a direction of travel, not a contrarian bet. AP2
   requires a "Trusted Surface" the page cannot draw over; OpenAI Apps and
   Anthropic's MCP connector both render consent in host chrome with a
   host-remembered "always allow." Four independent systems reinvented
   consent-at-the-key. That is the strongest signal the thesis is right.

---

## Cluster 1 — capability & authorization

Lineages: macaroons → Biscuit → UCAN → ZCAP (signature-chained attenuation) and
RFC 8628 → CIBA → FIDO hybrid (cross-device consent).

**Steal, in priority order:**

- **UCAN's `pol` predicate grammar** as the caveat model for `SessionDelegation`
  and grants — a closed, JSON-native operator set (`==`, `<`, `like`, `and`,
  `or`, `not`, `all`, `any` over jq-style selectors) that `schema.ts` can
  validate and the wallet can render. It is the *maximum* policy expressiveness a
  consent screen can honestly display. UCAN's `aud→iss` chain rule (terminating
  at the subject) is the verified-delegation algorithm for the hosted-wallet
  chain (user → hosted wallet → ephemeral page key), which the daemon walks back
  to `cert.user`.
- **Approval binds the exact call.** Sign the tool-call digest into the approval
  frame (CIBA push-mode hash binding + ssh `publickey-hostbound`). Cheap now,
  unfixable after the approval frame freezes.
- **RAR's `type/actions/locations` object** as the action-class grant schema,
  with request/grant symmetry — one schema serves the consent UI, the storage,
  and the revocation list.
- **RFC 8628 §5.4/§6.1 hardening for the connect-code tier:** consonant-alphabet
  codes (`WDJB-MJHT`, 20^8, no accidental words), relay-side rate limiting on
  `pair`/connect attempts, short expiry — with the entropy math written into
  `limits.ts`. Consent surfaces must state *what kind of thing* is attaching.
  Note the inversion risk: an attacker who obtains a victim's pairing code
  attaches *their* browser to the *victim's daemon* — strictly worse than the
  OAuth case — so the daemon-side pairing consent, not just the browser side,
  must show origin + fingerprint words, and auto-filled `/pair#code` links
  require a mandatory fingerprint cross-check (Storm-2372 proved wording-only
  mitigations lose).
- **Signature-as-revocation-id (Biscuit) + mandatory-expiry/bounded-store
  (ZCAP):** every cert/delegation's existing `sig` *is* its revocation handle;
  the daemon keeps a revocation set pruned at credential expiry; CLI and UI are
  views over the same set. **Ship revocation before delegation chains** —
  chains without revocation multiply blast radius (ZCAP's own revocation section
  is still "TODO" after 8 years; revocation designed last is revocation never
  shipped).

**Anti-lessons.** GNAP, ZCAP-LD, and macaroons-as-standard all combined maximal
expressiveness with unspecified rendering and late revocation — and none got
adopted. UCAN 1.0 broke its own wire format (JWT → DAG-CBOR) and stranded every
0.x implementation: **freeze AgentPort's signing envelope early**; a
canonical-JSON dialect change after ship is a full ecosystem break. Keep the
action-class set closed (unknown class ⇒ reject), matching the exact-`t`
registry discipline. Refuse UCAN's `sub:null` "powerline" equivalent — a
`SessionDelegation` with wildcard `origin` is ambient authority.

---

## Cluster 2 — browser harness (feeds ADR-021, extension-work's lane)

Every serious 2025-26 harness converged on an **accessibility-shaped text tree
with ephemeral refs**, beating both raw DOM (token blowup; Vercel's ~93%
reduction) and screenshots (Operator's OCR failures on high-entropy strings, and
screenshots make truthful failure *impossible*). Crucially, Playwright computes
its aria snapshot in **injected page-side JavaScript** — so a content script is
where the reference implementation already runs, not a second-class venue.

**Recommended addressing scheme for the content-script harness (hand this to
extension-work):** **generation-scoped semantic refs with a recorded fallback
ladder.**

- `page.snapshot` synthesizes an aria-shaped tree and returns
  `- role "name" [ref=g3e12]` lines, where `g3` is a page-generation counter
  bumped on every committed navigation *and* every snapshot (chrome-devtools-mcp's
  `${snapshotId}_${id}` prefix — makes a stale ref structurally detectable, not
  a heuristic).
- Interacting tools take `ref` **plus** a human `element` description param
  (Playwright's two-parameter addressing) — the description is for the wallet's
  approval card, which AgentPort uniquely needs.
- Internally, `ref → WeakRef<Element> + {role, name, testAttr, id, css, text}`
  (the DevTools Recorder selector ladder captured at snapshot time). Resolution:
  live element if still `isConnected` **and** role+name still match (this kills
  browser-use's adjacent-element misclicks, where the click *succeeds* on the
  wrong element and no error can catch it); else one ladder re-resolution; else
  the exact refusal string plus a fresh delta snapshot in the same response.
  **Never silently heal** — re-deciding is the agent's job (Stagehand's
  self-heal, inverted).
- Cross-frame: prefix refs with a frame ordinal (Stagehand's EncodedId),
  same-origin only; cross-origin frames are opaque nodes, not pretend-reachable.

**Waiting — adopt chrome-devtools-mcp's `WaitForHelper` verbatim** (all
primitives exist in a content script): after every action, race "navigation
starts within 100ms" (ignoring same-document types) → navigation completes
(≤3s) → `MutationObserver` quiet-window (100ms quiet, 3s cap). The one fix:
when the settle times out, **report it** ("DOM did not stabilize within 3s"),
don't swallow it and return success — that swallow is exactly ADR-021's
"truthful failure" gap.

**The page-change notice needs no new push machinery.** Copy playwright-mcp's
**response envelope**: every tool result carries `### Page` (URL/title/HTTP
status/console counts, rendered *on change*), `### Modal state`, `### Events`
since the last call, and the fresh snapshot. That is "the agent must be told the
page changed" solved as a pull-based diff on every result — which suits the
sealed channel (no new frame types). Name the change kinds with **WebDriver BiDi
vocabulary**: `navigationCommitted` (old document gone — all refs die here;
define ADR-021's same-origin survival boundary at exactly this event),
`fragmentNavigated`/`historyUpdated` (SPA route change — same document, refs
survive but meaning may not), `userPromptOpened` (harness blocked),
`contextDestroyed`. Expose one explicit `sameDocument: true|false` flag rather
than three event names (BiDi's own implementations get confused here).

**Truthful failure specifics:** vercel-agent-browser's "covered by
`<div#consent-banner>`" (from `elementFromPoint` at the target center) beats
"not clickable"; browser-use's "most likely the page changed" is a *guess* in an
error string — only say the page changed when a mutation/navigation event was
observed. `page.navigate(url|back|forward|reload)` as one merged tool
(chrome-devtools-mcp's shape) with a BiDi `ReadinessState` (`none`/`interactive`/
`complete`) `wait` param the agent chooses.

**Steal for the wallet/policy layer (feeds cluster 5):** Operator's four-tier
action policy — **proceed / confirm / watch / refuse** — with *measured recall*
as the acceptance test (they published 92%/94%; our e2e-invariant culture fits
this). **Watch mode = tool dispatch gated on `document.visibilityState`**
(trivially enforceable in a content script; Atlas's version was unenforced and
Willison's test walked right through it — any supervision claim must be a
checked invariant). **Takeover = a protocol state** where dispatch is suspended
and page reads return blank, and the agent is *told* it is suspended.

---

## Cluster 3 — relay & rendezvous (feeds ADR-016)

iroh shipped 1.0 ("dial keys, not IPs") — the ADR-016 endgame running in
production and independent validation of the whole "blind, stateless, fungible
relay" direction. WalletConnect v2 is the most successful "bring your own X to
any website" rendezvous in deployment and the source of the hard-won lifecycle
lessons.

**Recommended connect-code URI** (synthesizes NIP-46/NWC's identity-first
grammar, which fixes WalletConnect's identity-less topic, with WalletConnect's
mandatory expiry):

```
agentport://<agent-device-pubkey>?v=1&code=<one-time-claim-secret>&relay=<wss-url>&relay=<wss-url>&exp=<unix-seconds>&name=<label>
```

- **Authority = the daemon's Ed25519 device pubkey** (NIP-46/NWC; iroh). The
  wallet pins *who* before the first frame; the cert it receives must chain to
  this key or pairing aborts — this, not the relay portion, is what makes the
  relay list untrusted routing data.
- **`code`** — single-use claim secret consumed at claim time, echoed back
  NIP-46-style; authorizes cert issuance and nothing else (NWC's
  secret-as-standing-credential is the anti-lesson — a leaked screenshot drains
  the wallet). In an `https://…/pair#…` wrapper it rides the **fragment**, never
  the query, so it never reaches a server log (the existing `/pair#code=`
  convention generalizes).
- **`relay` repeatable, ordered, home relay first** (NIP-46 multi-relay; NIP-65
  "keep to 2-4"; iroh home relay) — multi-relay presence solved in the URI
  itself.
- **`exp` mandatory** (WalletConnect retrofitted it after stale URIs got
  double-scanned; validate with ±5min skew tolerance — an MSC4108 clock-desync
  bug deleted live sessions).

**Relay resource-bounds vocabulary — steal libp2p circuit-relay v2's
`Limit{duration, data}` + reservation-with-expiry.** An attachment-acceptance
frame should carry `{maxDurationS, maxBytesPerDirection, maxFrames}` so both
endpoints *learn* the bounds instead of discovering them by being dropped;
numbers go in `limits.ts` with rationale. libp2p v1→v2 is the canonical proof
that **a relay without explicit resource bounds becomes a free CDN and dies.**
Pair with TURN-REST-style HMAC tokens (`username=timestamp:id`,
`password=base64(hmac(secret, username))`) for *stateless* abuse control: a
restarted relay honors tokens minted before the restart, remembering nothing.

**Resume across relay restart:** iroh's radical answer — there is nothing to
resume *at* the relay; reconnect re-establishes because the key is the address.
Make this ADR-016(A)'s acceptance test: **a relay process restart must be
indistinguishable from a network blip**, because every routing fact is
re-derivable from what endpoints present (cert + epk + resume token). The
`AgentCert.location` field should become an ordered relay list (an
iroh-`NodeAddr`-shaped record: `{agentPubkey, relays[], cert}`), and NIP-65's
signed relay-list record is phase-C discovery verbatim.

**SAS hardening (three cheap moves on the fingerprint-word flow):**

- **Commitment before key reveal (Matrix `m.key.verification.accept`):** hash
  your epk and send it *before* the peer's key arrives, so neither side can
  grind its ephemeral to steer the SAS after seeing the other's. One field on
  one frame; without it, partial grinding degrades the 48-bit strength.
- **Numeric fallback** derived from the same HKDF output (three 4-digit numbers,
  Matrix's decimal scheme) — language-neutral and phone-dictation-friendly
  alongside the six English words.
- **Typed cancel codes** (`m.mismatched_sas` shape) — verification-failure
  teardown should carry a typed reason, not a generic close.

**Ratchet decision — settle it in an ADR: skip the DH ratchet permanently.**
AgentPort already has *inter-session* forward secrecy (epks die with the
attachment; resume mints fresh keys). Post-compromise security is near-worthless
here because both endpoints persist the transcript in cleartext (the agent's ACP
store, the daemon's fallback), so endpoint compromise yields the conversation
regardless of wire crypto. Every deployed peer agrees: WalletConnect (static
symkey, 7-day sessions), NIP-46/NWC (static ECDH), iroh (TLS 1.3 rekey only) —
none ratchet. The optional cheap symmetric hash-forward (per-frame key
evolution, closes only the *backwards* intra-session window) is worth it *only*
if it survives resume logic unchanged; otherwise per-attachment ephemeral +
short TTL + fresh-keys-on-resume is defensible against every deployed system.

**WebRTC direct-mode fallback (phase B):** fix **daemon = polite, wallet =
impolite** in perfect-negotiation terms (the browser tab is the flaky
user-driven side; let it win collisions), and carry SDP/ICE as *sealed* frames
so the relay never sees candidate IPs — closing the classic
signaling-server-learns-your-topology leak.

**Anti-lessons.** WalletConnect's v1 hard-shutdown broke live products the day
DNS flipped, and NIP-04 lingered next to NIP-44 for years because relays can't
force upgrades — the "relay and endpoints deploy together" invariant is the
right antibody, but it *dies the day third-party relays exist*, so plan explicit
version negotiation before phase C. Keep one well-known default relay as the
NIP-65-style "indexer" tier to solve discovery bootstrap.

---

## Cluster 4 — agent-protocol ecosystem (what we already consume, better)

MCP is at revision **2026-07-28** (stateless core, sessions removed, DCR
deprecated for Client-ID-Metadata-Documents, **Sampling/Roots/Logging
deprecated**). ACP is **v1 stable, v2 in draft** (which will rewrite
permissions, sessions, terminals, modes — `session/load` merges into
`session/resume`+`replayFrom`, *closer* to AgentPort's own resume design).
AG-UI ships the interrupt/`approveWithEdits` shape. AP2 is the definitive prior
art for the *spend* class.

**Adopt now (unused features of protocols we already speak):**

- **ACP's permission-option `kind` enum (`allow_once | allow_always |
  reject_once | reject_always`) is the remembered-consent vocabulary, already on
  our runtime wire one hop below the wallet.** The wallet needs a consent store
  keyed `(origin, agent, tool, action-class)` with grant-style TTLs, answering
  `allow_always` deterministically and rendering "stop asking" as ACP's own
  documented mode-switch-as-permission pattern. Cheapest high-value win, and
  immediately dogfoodable. **Caveat this feeds the daemon fix already landed**
  (`daemon: prove a single approval never becomes allow_always`, f429477): the
  daemon must never *auto-select* a durable option; a durable choice is only
  ever a decision the user explicitly made in the wallet.
- **AG-UI's interrupt + `approveWithEdits` as the approve-with-edits wire
  design.** `Interrupt{id, reason:"tool_call", toolCallId, responseSchema,
  expiresAt}` resumed with `{approved, editedArgs}` where `editedArgs` is a
  **full replacement, never merged** (merge semantics are a fingerprinting/
  ambiguity bug). The wallet validates edited args against the tool's
  `inputSchema` before sealing; the daemon substitutes before answering the
  runtime; the transcript renders the proposed-vs-edited diff. `expiresAt`
  discipline: pending approvals expire like grants.
- **Implement `class AgentPortAgent extends AbstractAgent` (@ag-ui/client).**
  `run()` = open attachment + prompt + map sealed frames to events (invert the
  existing `applyEvent()` adapter to *emit*); `connect()` fits the persistent
  attachment; `abortRun()` = cancellation frame; `getCapabilities()` derived
  from the grant. Payoff: CopilotKit and every AG-UI renderer becomes a free
  front-end for "your own agent on this site." This is the AbstractAgent
  question ADR-017 left explicitly undecided — the sweep's recommendation is
  *pull the lever*, framed as an adoption lever, not protocol alignment. (Note:
  middleware doesn't apply to `connectAgent()`, so approval logic must not live
  in middleware.)
- **ACP passthroughs the daemon strips today but shouldn't:** plans (`plan`
  updates → AG-UI activity/steps → free progress UI in the panel), slash
  commands (`availableCommands` → the composer), tool-call `kind`/`locations`/
  diff content (richer transcript; diffs render in the existing chat set),
  elicitation (`elicitation/create` forwarded to the wallet as a structured
  interrupt instead of failing). Pass tool `annotations` through the `McpBridge`
  to the agent (the grant strips them today — the agent deserves the
  `readOnlyHint`/`untrustedContentHint` signal when planning).

**AP2 for the spend class (the architectural steal).** *spend* is not a policy
decision like the other classes — it is a **signed artifact chain**. AP2's
open/closed mandate split *is* remembered consent done cryptographically:
open mandate (user-signed, typed constraints `budget`/`amount_range`/
`allowed_payees`/`agent_recurrence`/expiry, `cnf` device-key binding) → closed
per-execution record (agent-signed, hash-bound to the open mandate via
`sd_hash`). AgentPort's structure is already homologous; the upgrade path is:
make the grant a user-signed object with typed constraint entries, and have the
daemon emit signed per-execution receipts hash-bound to it. That gives
remembered consent an *audit trail* instead of a boolean, and positions the
AgentPort wallet as a future AP2 "Trusted Surface" (it already holds the user
key and renders consent in chrome the page can't draw — AP2's exact requirement).

**Positioning (WebMCP).** The conformance memo (`reviews/webmcp-conformance.md`)
already withdrew the unqualified claim. The issue tracker confirms the strategy:
editors scoped out external agents, identity, and consent; issue **#165**
(remote HITL for external clients) is the exact hole AgentPort fills, with
demand and no design; **#198** (`humanInTheLoopHint` ladder) is AgentPort's
action-class vocabulary growing site-side. Show up in both as the external-agent
counterpart. Adopt **`untrustedContentHint`** into `SiteTool` now — it's a
prompt-injection taint marker that costs nothing and feeds the daemon's
"every tool result is hostile" rule.

**Web Bot Auth (the inverse, as an opt-in feature).** It proves an agent's
operator *to a site* — the philosophical inverse of "the site learns nothing."
But the daemon holds an Ed25519 key already; signing daemon-originated fetches
with `tag:"web-bot-auth"` and a user-published pseudonymous key directory would
let Cloudflare-fronted bot-gated sites (much of the web) *admit* the user's
agent. Design it as a **documented opt-in disclosure tier** in the grant
("identify my agent to sites that demand it"), disclosing the user's chosen
pseudonym, never the runtime — turning the inverse protocol into a feature where
AgentPort controls *what* is disclosed.

**Anti-lessons.** MCP removed protocol-level sessions and SSE resumability
within two years ("re-issue as a new request" beat replay buffers) — mirrors
AgentPort's count-not-buffer decision; keep it. ACP rewrote permissions/
sessions/terminals/modes wholesale in ~a year — `AcpRuntime` must *declare which
ACP it speaks* and the v2 adapter is a versioned tier. Elicitation had to *ban*
collecting secrets through structured forms — design AgentPort's approval/
elicitation surfaces with that ban from day one. A2A is cleanly orthogonal
(agent-to-agent service delegation vs user-to-site attachment); the only note is
the `AgentCard` vs `AgentCert` name collision — disambiguate in one doc line.

---

## Cluster 5 — injection containment (feeds Gate C §6)

The boundary fact that frames everything: **ACP's permission channel only covers
calls the runtime chooses to surface — there is no mechanism to veto a tool call
the agent executes without asking.** So AgentPort's enforcement points are
exactly four: (a) what tools *exist* at spawn (runtime flags/settings), (b) the
`McpBridge` it owns, (c) the permission channel when the runtime routes through
it, (d) OS-level sandbox/egress under the runtime. Anything assuming mid-loop
veto of arbitrary calls is not implementable. The strongest structural defenses
(CaMeL, FIDES, plan-then-execute) live *inside* the loop AgentPort deliberately
doesn't own.

**Adopt, in priority order:**

1. **Session-scoped own-tool minimization as trifecta-leg removal, enforced at
   spawn.** Willison's lethal trifecta (private data + untrusted content +
   exfiltration channel) is created *by construction* on any attachment — but
   the daemon configures the runtime *per attachment*, so it can remove a leg
   per session rather than detect injections. Default profile: agent keeps
   reasoning + lent site tools, **loses shell, personal files outside a scratch
   dir, mail/MCP servers, and open-ended fetch** — tools *absent from the model's
   context* (Claude Code deny-rules remove the tool entirely), not prompted-for.
   This is the only mitigation in the entire corpus that is simultaneously
   deterministic, loop-agnostic, and *measured best-in-class*: AgentDojo's
   tool-filter defense is ASR 47.69% → 6.84% at 73% utility, beating every
   classifier. Escalation back to a personal tool is a trusted-surface approval
   naming the tool and origin. **Say it in the consent UI**: the session profile
   is a trifecta-leg remover.
2. **Action-class gates on a trusted surface, remembered per origin × class.**
   publish / purchase / share-personal / destructive / navigate-external always
   confirm in the wallet or daemon UI (never in-page DOM the site can spoof);
   allow-always persists per origin+class and is *voided by any lent-tool
   definition change* (rug-pull defense); no mode may skip the always-ask
   classes (Claude Code's `requiresUserInteraction` survives even bypass mode).
   "Externally visible" is classified by *effect* (bytes leave the origin), not
   tool name — a lent `updateDocument` on a public page is an exfil channel;
   `navigate` is externally-visible (URL query strings carry data).
3. **Bridge-level deterministic policy + provenance envelope on every lent-tool
   result.** CaMeL's policy slice (argument policies enforced in the bridge —
   e.g. a tool may only receive URLs on the attachment origin) + FIDES's sink
   annotations (`accepts_untrusted`, confidentiality caps) + spotlighting's
   datamarking (page text interleaved so it can't be read as instructions —
   measured 50%→3% ASR at ~zero utility cost). Every bridge result wrapped in a
   fixed untrusted-provenance envelope with unspoofable tokens (strip/escape
   envelope markers from payloads — the canonical-JSON discipline is the right
   instinct). **This is attenuation, not enforcement** — say so; it layers
   *under* gates 1–2, never instead of them.
4. **Tool-definition pinning + description hygiene.** Hash `SiteTool`/WebMCP
   descriptors at consent; mid-session mutation = rug pull = session-fatal for
   remembered consent. Tool *descriptions* are an injection surface (they enter
   the agent's context as trusted-looking text — the documented #1 MCP attack);
   cap length, strip imperative boilerplate, display them on the consent surface.
5. **An AgentDojo-style adversarial harness over the real wire + OS sandbox
   under the runtime.** Hostile page/tool-result fixtures attempting cross-tool
   exfiltration (page text → personal tool), lent-tool abuse beyond grant, and
   consent-scope escalation — using the "Important message" attack template
   family as the floor (it dominates AgentDojo at 57.7% vs 5.41% for "ignore
   previous instructions" — phrasing matters more than presence) and an
   adaptive Best-of-N attacker as the ceiling. Report **both** numbers
   (static-suite 0% + adaptive residual — the honest shape; cf. Anthropic's 0%
   challenge set vs 1% adaptive). The acceptance claim must mirror the
   tool-filter finding: with the default profile, measured cross-tool-exfil ASR
   is 0 because the reachable tools make the attack *structurally impossible* —
   not because a detector caught it. `srt`-shaped filesystem/network confinement
   on the VPS bounds what even a fully hijacked runtime reaches — the backstop
   for everything ACP can't see.

**What remains unsolved, stated honestly (for the Gate C ADR).** Whenever a
session genuinely needs *both* a personal tool and page-derived text ("read this
page and file it in my notes"), untrusted data and a consequential capability
meet inside a model that cannot architecturally distinguish data from
instruction — and every mechanism here then degrades to a human approval
(fatigue erodes it; Anthropic rebuilt its whole sandbox story around an 84%
prompt reduction *because* prompts stop working when there are too many) or a
probabilistic filter whose best published residual is 1–3% against adaptive
attackers, which Willison correctly calls a failing grade. AgentPort's ceiling
is to make the dangerous combination **rare** (default-deny profiles), **small**
(argument policies, origin-capped side effects, sandbox), **visible** (trusted-
surface approvals naming tool + origin), and **tested** (the harness above).
Write Gate C as **risk budgeting, not elimination** — OpenAI's own posture:
"unlikely to ever be fully solved."

---

## Cluster 6 — browser provider-picker primitives

Every precedent where the browser mediates between a site's request and a
user-chosen provider: Payment Request/Payment Handler, FedCM, WebAuthn hybrid
transport (caBLE v2), Digital Credentials API, Credential Management mediation,
EIP-6963/Wallet Standard/NIP-07, WebUSB's chooser pattern.

**The Payment Handler postmortem is the most important artifact.** Its
skeleton is shape-identical to `navigator.agent` (provider registers → site
declares need → browser filters by an authorization rule → browser-owned
picker → gesture → scoped event `{topOrigin, …}` to the provider →
`respondWith()` back) — and it failed as a *platform*: single-engine for eight
years, incumbents ignored it, the browser's generic sheet lost to
provider-owned UX, its in-browser provider registry (`PaymentInstruments`) was
removed for privacy leaks, and every presence probe it shipped was serially
destroyed by the privacy ratchet. What *survived* is Secure Payment
Confirmation — the narrow, cryptographically bound consent ceremony that made
one metric measurably better *for the site* (Stripe pilot: +8% conversion).
FedCM survived its dead forcing-function the same way: one giant deployed
caller plus a genuine UX win. **Prediction: `navigator.agent` adoption comes
from one flow measurably better for the site, not from platform elegance —
and the durable kernel is the trusted consent surface plus a scoped, expiring,
cryptographically bound grant, which is exactly AgentPort's existing invariant
set.**

**Steal, concretely:**

- **FedCM's fetch discipline + push registration.** The structural rule: *no
  message carries both site identity and provider identity until consent*
  (FedCM's accounts fetch is credentialed but RP-blind; RP identity joins only
  at the post-consent assertion). The IdP Registration API's push model — the
  provider pre-registers its roster with the mediator so *zero* provider-bound
  network precedes consent — kills even the timing side-channel FedCM's spec
  candidly admits. AgentPort is half-built this way already (sealed frames,
  relay-stamped identity); adopt the vocabulary, *enforce* the pairwise
  per-origin identifiers FedCM only recommends (ADR-009 already commits to
  this), and audit the relay for the timestamp-join attack.
- **CredMan's `mediation` enum as the remembered-consent model, consumed
  verbatim.** `silent | optional | conditional | required` plus the per-origin
  **prevent-silent-access flag**: mediation is the default state; only the
  *user* in trusted UI may upgrade an origin to silent reattach; the *site*
  can only downgrade itself (`preventSilentAccess()`); clearing site data
  revokes; silent grants carry `isAutoSelected` so the daemon knows no human
  clicked. This is a shipped four-browser vocabulary that maps one-to-one onto
  AgentPort's consent tiers — first attach = `required`, remembered =
  `optional` with ambient indicator, sensitive-tool re-approval = `required`,
  availability chip = `conditional`. Do not invent a parallel vocabulary.
- **caBLE v2 (WebAuthn hybrid) as the phone-wallet pairing blueprint, nearly
  field-for-field.** QR carries a CBOR map {ephemeral pubkey, 16-byte secret,
  relay-domain index, timestamp, linking flag, operation hint}; the BLE advert
  welds *proximity into the handshake PSK* (not a boolean); Noise
  KNpsk0/NKpsk0 runs over a ciphertext-only tunnel — **which is structurally
  AgentPort's relay, already built**. The linked tier ({contact ID, link
  secret, wallet name, signature}; later approvals are push-initiated, no QR)
  is the remembered-phone design — build it early, QR-every-time died in user
  testing. Hash-derived relay domains (`SHA-256("agentport relay domain" ||
  uint16)`) let self-hosted relays need no client update. Deliberate
  documented difference: AgentPort's phone is an *approver*, not a credential
  holder, so per-approval proximity is policy, not inheritance.
- **EIP-6963/Wallet Standard's announce-request handshake for the extension
  era, shipped now.** `agentport:announceProvider` / `agentport:requestProvider`
  with frozen `{info: {uuid, name, icon, rdns}, provider}` — both directions
  announce so load order never matters; Wallet Standard's unstoppable
  callback-register events are the strongest page-world variant. NIP-07 is the
  cautionary tale: a bare injected global with no discovery protocol ossified
  (multi-extension collision open for three years, unfixable). **Do not let
  `navigator.agent` ossify as a bare global the extension owns; make discovery
  event-based from day one and have `connect.js` implement the dapp side.**
- **DC API's chooser posture** — the only precedent that cleared *two* engines
  (Chrome 141 + Safari 26). Gesture-gated, mandatory platform chooser,
  anti-fingerprinting capability queries ("MUST NOT vary the response based on
  hardware availability" — presence answers must not leak roster contents),
  and the sandboxed **matcher** idea: each provider ships declared policy the
  mediator evaluates against `{request, origin}` *before* the picker renders —
  a concrete design for "which of my agents may attach to this site with these
  tools." Its retreat from an open protocol registry to hardcoded protocols
  says: enumerate protocols in the spec, don't build a registry first.

**The explainer sketch (the endgame paragraph).** If `navigator.agent` were
proposed tomorrow: live in (or exactly mirror) the Credential Management
container — `navigator.credentials.get({agent: {tools, protocol:
'agentport-v1', mode, context}, mediation})` — inheriting the mediation
vocabulary, `preventSilentAccess()` revocation, permissions-policy delegation,
and clear-site-data revocation for free; registration copies FedCM's push
model, not Payment Handler's registry; the runtime flow copies Payment
Handler's event kernel (picker → gesture → scoped event → `respondWith`);
cross-device is one sentence ("phone approval uses the hybrid transport
pattern, CTAP 2.2 §11.5, over the AgentPort relay"). The pitch is *not* "a
provider platform for agents" — it is "a browser-drawn consent surface
granting a scoped, expiring, revocable, E2E-sealed capability," with the Blink
evidence checklist: the extension provider as demonstrated demand, page-world
announce spoofability as the workaround's abuse story (EIP-6963's own admitted
limit), the chooser's leak-nothing property as the privacy win, WebMCP sites +
ACP runtimes as committed parties on both sides. WebUSB's veto by two engines
shows an *unbounded* grant loses regardless of chooser UX — AgentPort's grant
being scoped/expiring/revocable is the property to lead with, because it is
the property WebUSB lacked.

---

## Recommended build order

Sequencing honors ADR-021's binding rule (remembered consent may not ship before
scoping, visibility, revocation, and the Gate C own-tools firewall) and clusters
the cheapest high-value steals first.

1. **Revocation + "who has my agent" trust surface** (Gate B §5; cluster 1's
   sig-as-revocation-id; ADR-021's prerequisite). Daemon `revoke()` that closes
   live sessions with a typed reason and reconnects unbound; `agentport
   status/list/revoke` CLI (ssh `-D`/`-d` shape); the extension origins-list UI
   (extension-work's lane) calls that daemon/CLI surface. *This session's lane.*
2. **Approval binds the exact call** (cluster 1) + **approve-with-edits**
   (cluster 4, AG-UI shape) + **an approval-provenance field** (model vs
   surface; the consent review found gated page calls and the runtime's own-tool
   requests share one untyped boolean decider). One wire change, designed
   together — schema entry + `limits.ts` bound + wire fixture, deploy relay
   first.
3. **Own-tool firewall / session profiles** (Gate C §6, cluster 5). Default
   trifecta-leg-removing profile expressed as per-runtime spawn config, with the
   AgentDojo-style adversarial harness as its acceptance gate.
4. **Action-class vocabulary** (clusters 1+4). Closed set, RAR-shaped grant
   entries, MCP/ACP/WebMCP annotations projected on as clamped claims, renderer
   shipped with it.
5. **Remembered consent** (ACP `allow_always` store, cluster 4) — *last*, on top
   of 1–4, as AP2-shaped open grants with signed closed receipts.
6. **Parallel, independent of the gates:** connect-code URI + multi-relay
   presence + relay resource-bounds (cluster 3, ADR-016 rung A); the
   `AbstractAgent` adoption lever (cluster 4); SAS commitment hardening
   (cluster 3).
