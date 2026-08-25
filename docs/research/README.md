# Research archive — what was surveyed, and what became of it

On 2026-08-20 six independent agents surveyed this repository, one lens each,
against the tree at `f7c8ee6`. Their reports are in `2026-08-survey/`, frozen.
This file is the part that must stay true: every finding, and its disposition
in `f7c8ee6..main`.

**How to read a disposition.** CLOSED names the commit that closed it and the
symbol you can go and look at. PARTIAL means some of the finding shipped and
the rest is named. OPEN means **nothing in `f7c8ee6..main` closed it** — that
is a mechanical statement about the commit range, not a judgement that the
finding was wrong. Several OPEN items are deliberately deferred and say so.

The reports themselves are not rewritten as things ship. A survey that gets
edited to agree with what happened afterwards is no longer evidence of what
was true before, and the only reason to keep it is that it was true before.

---

## The shape of the result

Of 62 findings across five lenses (the sixth, `landscape.md`, is reference
rather than findings), **37 are closed, 6 partial, 19 open** (the harness's
two navigation findings closed on 2026-08-25). The open set is
not a backlog of neglect: it is dominated by two deliberate gates — remembered
consent behind ADR-019's Gate C, and pairwise identity behind
`docs/ADR-026-pairwise-agent-identity.md` — plus a cluster of P2/P3
consolidation work that no invariant depends on.

Two findings were **wrong**, and are marked so below. Both were mine to check
and both were corrected by going to primary sources rather than by argument.

---

## domain.md — do the entities own their rules?

The lens that paid best. Its thesis — *the shapes are modelled well and the
rules are not* — produced three extractions that each closed a live defect.

| # | finding | disposition |
|---|---|---|
| P0/M | `SessionDelegation` judged by three drifted hand-written copies | **CLOSED** `24561c2` — `packages/protocol/src/delegation.ts#delegationAuthorizes`, one judge, closed denial set. The survey's "nobody checks `issuedAt` against the clock" became the `not_yet_valid` clause. |
| P1/M | attachment authority is a bare tuple; live revocation is not one of its checks | **CLOSED** `40a98eb` — `packages/daemon/src/authority.ts#AttachmentAuthority`. Revocation became a clause of `error()` rather than a `setInterval` in the CLI. |
| P1/S | "is this tool gated?" spelled seven times, two of them consent screens | **CLOSED** `24561c2` — `packages/protocol/src/grant.ts#isGated`, all seven call sites replaced. |
| P1/L | `content.ts` is two programs; the widget half is an 11-variable module state machine | **CLOSED** `beff95f` — `packages/extension/src/widget.ts#WidgetSurface`. |
| P2/S | terminal-resume rule is a duplicated string set over a free-text field | **CLOSED** `24561c2` — `packages/protocol/src/denials.ts#isTerminalResumeDenial`; `a645aeb` then narrowed the wire field itself to the registry. |
| P2/M | `AttachmentPolicy`'s justification names a route it does not own | **OPEN** — the two-input fix predates this survey; the duplicated *routing* forks it identified are still there. See composition P1/M. |
| P2/M | `sw.ts` is a session registry with two unrelated services bolted on | **CLOSED** `8976c2d` — `packages/extension/src/consent-windows.ts#ConsentWindows` and `packages/extension/src/popup-api.ts`; the registry itself deliberately kept whole. |
| P2/M | `daemon.ts` carries a relay client and a wire-bounding library | **CLOSED** `b70668b` — `packages/daemon/src/relay-link.ts`, `packages/daemon/src/bounds.ts`. |
| P2/S | `wallet.ts` hides a request/response multiplexer with a known past bug | **CLOSED** `7497235` — `packages/client/src/correlator.ts#FrameCorrelator`, its two recorded bugs asserted directly. |
| P2/S | the extension redefines five protocol bounds as its own | **OPEN** — `packages/extension/src/bridge.ts#LIMITS` still restates them. |
| P3/S | four re-derivations of what the page may learn | **OPEN** |

## composition.md — are the seams real?

Verdict adopted wholesale: the tier split is sound, the *predicates* are
duplicated. Its most valuable finding was not a duplication at all.

| # | finding | disposition |
|---|---|---|
| P1/S | the gated predicate, seven copies | **CLOSED** `24561c2` (same as above) |
| P1/M | `aguiStream`'s subscription set is not total; `ask` fell out and stalls the demo five minutes | **CLOSED** `1435732` — the set is built from a `Record<keyof SessionEvents, …>`, so an omission is a type error, and `ask` renders. The best single catch of the survey: a live five-minute stall nobody had reported. |
| P1/S | invariant 9's terminal-resume rule as two string lists | **CLOSED** `24561c2` |
| P1/M | `attachmentPolicy()`'s routing duplicated in two drifted forks | **OPEN** |
| P1/S | the extension re-states protocol bounds and degrades silently | **OPEN** |
| P2/M | three hand-written projections of the same stream into the same chat store | **OPEN** |
| P2/S | `createWalletProvider` has one consumer and the tier it was for refuses it | **OPEN** |
| P2/M | `PageSession` and `AgentSession` implement the same contract twice | **OPEN** |
| P2/S | `McpBridge` mints a private random id, so the boundary cannot be correlated in logs | **OPEN** — `packages/daemon/src/mcp-bridge.ts#register` still generates its own. |
| P3/S | the WebMCP merge rule is copied into both harvesters | **PARTIAL** — `fa69923` centralised the belief; `19df9ef` fixed the shared converter. The merge rule itself is still two copies. |

## capabilities.md — what the wire cannot express

The lens that set the protocol agenda. Its P0s became protocol v7.

| # | finding | disposition |
|---|---|---|
| P0/L | the grant is frozen at attach — nothing can add, remove or re-declare a tool | **CLOSED** `56cabda` — `grant.update`, with the narrow/widen asymmetry (widening needs a fresh delegation `grantHash`). |
| P0/S | `SurfaceDescriptor.context` and `Prompt.context` reach the daemon and are discarded | **CLOSED** `ce61d12` — a shipped false affordance, now threaded into the turn. |
| P0/L | everything is text: no content blocks, attachments or images | **PARTIAL** `ff3a285` — images upload-only, one budget, refused early. `resource_link` and download deliberately deferred with reasons recorded at `PromptImage`. |
| P1/M | the harness cannot navigate, wait or search | **CLOSED** — `6dfb81c` shipped find/waitFor/select/setChecked/pressKey, and `page.navigate` landed 2026-08-25. Both things ADR-021 deferred it for turned out not to be protocol territory: `page.*` already rides `site_tool` authority, and the cross-origin rule derives from `reclaimKeyFor` rather than being decided beside it. See that ADR's addendum. |
| P1/L | consent is never remembered, so the harness trains reflexive approval | **OPEN — deliberately.** Gated behind `docs/ADR-019-security-hardening.md` Gate C containment. |
| P1/M | a detach cancels the turn outright and nothing reports completion | **OPEN** |
| P1/M | no surface lists what holds your agent, so revocation is unreachable | **CLOSED** `d7aa6dc` — the popup lists holders and takes authority back. |
| P1/L | concurrent attachments spawn separate agent processes — "one agent everywhere" is N agents wearing one name | **CLOSED** `1a0d29d` — `AcpHost` owns one child process with per-session token isolation, plus a `maxSessions` cap answering `agent_busy` honestly rather than hanging. |
| P1/L | every site learns a stable agent public key — a cross-origin correlator | **OPEN — designed, not built.** `docs/ADR-026-pairwise-agent-identity.md` (`11e86b5`) specifies HKDF-derived per-origin identity and **gates store submission on it**, because the identifier a stranger's site first sees is the one it keeps. |
| P2/S | a sleeping paired agent is reported as "no agents paired yet" | **OPEN** |
| P2/M | tool calls are one-shot: no progress, no streaming, no deadline | **PARTIAL** — `40a98eb` gave approvals a deadline; progress and streaming are open. |
| P2/M | of eight `WEBMCP_NOT_IMPLEMENTED` entries, two are worth building | **CLOSED** `fa69923` — the belief moved to the verified 2026-08-19 draft and the negative claim has one home, `packages/client/src/webmcp.ts#WEBMCP_NOT_IMPLEMENTED`. |
| P3/S | no remembered per-origin agent choice | **OPEN** |

## harness.md — the wedge, and what a store reviewer will ask

| # | finding | disposition |
|---|---|---|
| P0/M | the approval card cannot name what the agent is about to click | **CLOSED** `e5b749b` — the card names its target and refuses loudly. The survey's argument stands as the reason: training reflexive approval is worse than not asking. |
| P0/M | `agentport revoke` does not reach an extension attachment at all | **CLOSED** `40a98eb` — a false security guarantee, found here. Every revocation check sat inside a delegation guard, so the direct-key tier was unreachable. Now per-origin tombstones judged across tiers. |
| P1/S | an unanswered approval window blocks the turn forever | **CLOSED** `8976c2d`, `c1d0af2` |
| P1/L | the harness cannot see shadow DOM or any iframe, and reports "empty" rather than "cannot see" | **CLOSED** `6dfb81c` — honest blindness counts, open-shadow recursion. |
| P1/L | four missing verbs | **CLOSED** — `6dfb81c` plus `page.navigate` (2026-08-25). |
| P1/S | the obstruction check treats "I could not look" as "it is clear" | **CLOSED** `6dfb81c` — three states (`clear`/`blocked`/`unknown`). Silence had meant permission on the one check between a borrowed agent and the wrong button. |
| P1/M | the extension announces itself on every website before any consent | **CLOSED** `13b07ff` — `packages/extension/src/enablement.ts`; the extension exists only on enabled origins. |
| P1/L | remembered consent has no store, surface or revocation path | **OPEN — deliberately**, same Gate C. |
| P2/L | the conversation dies at an origin boundary | **OPEN** |
| P2/S | page-tier reclaim is not scoped to the tab | **OPEN** |
| P2/M | the two riskiest paths have never executed in a real browser | **CLOSED** — `scripts/extension-ui-smoke.ts` runs the real unpacked extension in Chrome for Testing. It immediately earned itself: `isVisible` used viewport coordinates, so everything above the fold read as hidden after any scroll. |
| P2/M | the manifest is store-shaped; the background behaviour and listing story are not | **PARTIAL** `13b07ff`, `38fa984` — enablement, key wrapping, single-purpose justification, listing copy, `/privacy`. Submission itself is open behind ADR-026. |

## vision.md — what a stranger actually meets

The lens that found the live front-door breakage. Its five MOVEs were adopted
as the phase ordering.

| # | finding | disposition |
|---|---|---|
| P0/S | MOVE 1 — the published CLI's first printed link is a dead page for every stranger | **CLOSED** `709b9fd` — the third instance of the requirement-6 class. `/pair` now names the extension-free wallet route and the CLI prints both. |
| P0/S | MOVE 2 — the landing page's hero snippet throws before it reaches the network | **CLOSED** `709b9fd` — and `scripts/snippet-check.ts` now EXECUTES the snippet from both front doors rather than eyeballing it. A fourth instance was found and fixed in `17915b3`. |
| P1/M | MOVE 3 — the default runtime has an undeclared prerequisite and fails opaquely at attach | **CLOSED** `9a91325` — `packages/daemon/src/acp-preflight.ts#probeAcpRuntime` and `packages/cli/src/doctor.ts`. |
| P1/L | MOVE 4 — pick the wedge explicitly: the generic page harness, not the script tag | **ADOPTED** as strategy; drove phases 3–5. |
| P1/L | MOVE 5 — extension distribution is engineering, not a release decision | **PARTIAL** `c6777f9` corrected the claim in AGENTS.md; `13b07ff`/`38fa984` did the engineering. The survey was right and the repo's own documentation was wrong. |
| P1/S | the site is still told which runtime the user runs — the one "learns nothing" item that was false in shipped code | **CLOSED** `7eb7694` — runtime disclosed only to the user's own key. |
| P2/M | adoption-signal blocker map | **ADOPTED** as sequencing input. |
| P2/M | "your memory" is delivered by working directory and config, not conversation | **OPEN** — the claim should narrow or the capability should grow; neither has happened. |
| P3/S | deployed state should be cheap to re-check | **CLOSED** `709b9fd` — `scripts/deployed-check.ts`, byte-comparing the deployed front door against this tree. |

## landscape.md — the external record

Seventeen primary-source sections, not findings. It is the reason several
plans changed shape, and two of its checks corrected claims made earlier in
the same session:

- **WebMCP** is a CG Draft dated 2026-08-19 — `document.modelContext`, with
  `exposedTo` scoping **documents, not agent classes**, and the declarative
  variant **not normative**. The earlier belief was five months stale.
- **MCP's 2026-07-28 revision** exists in **no published SDK**. That turned a
  planned `McpBridge` rewrite into detection plus a `runtime:check` canary —
  the right call, and only visible because someone checked the registry
  instead of the changelog.
- **ACP's remote-transport RFD** is Active and defers exactly what AgentPort
  solved, which is why `docs/standards/acp-remote-transport-review.md` exists.

`19df9ef` later walked the supply this document predicted and found it real:
three Shopify Liquid storefronts serving ten commerce tools to a
user-supplied agent, nothing excluding us — by mechanism rather than by named
right, which is the distinction the consumer-class filing turns on.

---

## Preserved work that never landed

On 2026-08-24 this repository had sixteen worktrees and seventeen branches
attached to it, twelve of them holding uncommitted changes. Fourteen branches
were already contained in `main`. The rest was audited rather than assumed,
and the measurement is the useful part: across all twelve dirty worktrees
there were **zero net-new tracked files**, and eleven of the twelve were
80–98% already in `main` — what remained was superseded prose, renamed
symbols and stale check counts.

Nothing was discarded. Every uncommitted change was captured with
`git stash create`, which builds a commit object without touching the
worktree, and pushed to `refs/wip/*` on origin:

```bash
git ls-remote origin 'refs/wip/*'                    # what exists
git fetch origin 'refs/wip/*:refs/wip/*'             # bring them local
git show refs/wip/wf_af2cca26-9af-6                  # read one
```

They are under `refs/wip/` rather than `refs/tags/` deliberately: durable and
off-machine, but absent from the tags and releases UI, so a public repository's
tag list still shows only releases.

As of 2026-08-25 **both refs that held real work have been landed**, so the
archive is spent — kept because reading an original costs nothing and
re-deriving one is expensive, not because anything is owed to it:

| ref | what is in it | why it did not land |
|---|---|---|
| `refs/wip/wf_af2cca26-9af-6` | the `page.navigate` prototype this ref was kept for | **LANDED 2026-08-25.** Ported onto the current harness rather than merged — it was written against `page.listElements`, which `packages/extension/src/pagetools.ts` replaced with handle-based `page.find`. The prototype's own reasoning survived intact: same-origin only, script schemes refused, answered before the document is torn down. Kept for provenance, not because anything is owed to it. |
| `refs/wip/untracked` | `pagetools-check.ts`, a 340-line offline happy-dom harness asserting that every tool is gated as its grant claims, that `display:none` and `[hidden]` controls are never offered, that truncation is reported truthfully, and that reads carry the untrusted marker | written against the same older API. `packages/extension/check.ts` now covers part of this ground; the delta is worth reading before rewriting it from scratch |

`refs/wip/untracked` exists because `git stash create` captures **tracked**
changes only. Three untracked files would otherwise have survived as loose
blobs, recoverable until the next `git gc` and not one moment longer.

The one part of the archive still worth reading is the rest of that harness.
Only two of its assertions were ported; it also covers truthful truncation
reporting and the element cap's note, against an API that no longer exists.
Whoever next extends `packages/extension/check.ts` should read it before
writing those from scratch.

When it stops being worth keeping, it goes in one command:

```bash
git ls-remote origin 'refs/wip/*' | awk '{print ":"$2}' | xargs git push origin
```

## What the survey got wrong

Kept deliberately, because a research archive that records only its hits is
advertising.

1. **"Deployed and main are effectively the same system."** True at
   `f7c8ee6` and false within a day. `vision.md`'s P3/S proposed making the
   check cheap, which is the durable half; the claim itself now has an
   automated answer instead of a human one.
2. **The WebMCP belief the harvesters encoded** — five months stale, wrapping
   a method the draft removed in March. Found by checking, not by reasoning,
   which is the general lesson: every claim in `landscape.md` that mattered
   was one somebody had assumed rather than fetched.
