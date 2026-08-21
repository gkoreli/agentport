# The missing consumer class: a user-supplied remote agent

Drafted 2026-08-21. **Not yet filed.** Filing is the owner's act, not this
document's.

**Where this goes:** [webmachinelearning/webmcp#116 — "Agent allowlist use
cases and requirements"](https://github.com/webmachinelearning/webmcp/issues/116)
is the live thread, opened per a WG resolution and seeded with exactly the
taxonomy question this document answers ("browser agent, extension agent,
in-page agent, iframe agent etc"). This is written as a comment for that
issue, not as a new issue — a new issue would fragment a discussion the WG
already resolved to hold in one place.
[#165 — "Human in the Loop support for non-browser clients"](https://github.com/webmachinelearning/webmcp/issues/165)
is adjacent (our consent surface is exactly a HITL answer for a non-browser
client) and the comment cross-references it once rather than arguing there.

Verified against the live state on 2026-08-21: the spec is a Draft Community
Group Report (2026-08-19); `exposedTo` takes origins and scopes which
*documents* may access a tool; agent exposure happens through an
implementation-defined "observation" mechanism; and per the discussion in
#116, the WG is considering a `native-agent`-style keyword for the *built-in*
agent specifically. No named class covers the case below.

---

## Paste-ready comment for #116

The seed comment's taxonomy — browser agent, extension agent, in-page agent,
iframe agent — is missing the one class where the **user** chose the agent,
and we think naming it changes what the allowlist design needs to be.

**The class: a user-supplied remote agent, mediated by an extension.** The
agent is not the browser's, not the page's, and not *in* the extension: it
runs wherever the user put it (their own machine, their own server), on
their own subscription, with their own memory and configuration. The
extension is only the courier — it harvests the page's registered tools,
holds the consent surface, and relays calls to the agent the user already
trusts. We ship this today (AgentPort, an open implementation), so the
questions below come from running code rather than a thought experiment.

**Why a site should care that this class exists.** Every named consumer in
the current taxonomy makes someone other than the user pick the model: the
browser vendor (built-in), the site (in-page, iframe), or the extension
author. A user-supplied agent inverts that — the site declares *capability*,
the user supplies *agency* — and the site gets an assistant with no
inference bill, no SDK, and no model choice to defend. For a site deciding
whether registering tools is worth it, "any agent your users already pay
for can use them" is a materially different value proposition from "the
browser's agent can use them."

**What the class needs from the spec — three small things, none of them new
API surface:**

1. **A name.** Allowlist vocabulary is being designed now (`native-agent`
   is on the table). If the vocabulary ships with names for the browser's
   agent and nothing else, every other consumer becomes "whatever the
   built-in isn't" — undistinguishable to an author who would happily
   allow a user-chosen agent but not an arbitrary extension's, or vice
   versa. The distinction that matters to authors is *who selected the
   agent*, and today it is not expressible.

2. **A defined composition between observation and extension mediation.**
   Observation is implementation-defined, and the explainer expects
   implementations to convey "relevant security information" (originating
   origin, etc.) to the built-in agent. An extension mediating for a remote
   agent gets none of that channel: it sees `registerTool()` because it
   runs in the page, and that is all it sees. If observation grows
   agent-relevant metadata that never reaches script, the mediated classes
   silently fall behind the built-in one. We would like the spec to say
   either "observation-conveyed metadata is also script-observable" or
   "it is deliberately not, and here is why."

3. **A statement on whether `exposedTo` gates observation.** `exposedTo`
   scopes which *documents* may access a tool. An extension content script
   executes in the page's realm, so a same-origin-scoped tool is visible to
   it regardless of what the author meant about *agents*. Today an
   extension cannot know whether an author who wrote `exposedTo: [self]`
   intended "this document only" (we comply by construction) or "the
   built-in agent only, not you" (we cannot detect that intent at all).
   One sentence in the spec resolves this ambiguity for every mediating
   implementation.

**What we are NOT asking for:** no new registration API, no weakening of
same-origin defaults, no requirement that any implementation ship remote
agents. Sites keep full control through the allowlist being designed here —
we are asking that the vocabulary be able to *say* "an agent my user
brought," so that authors can decide about it deliberately instead of by
accident of taxonomy.

One implementation note that may be useful to #165 as well: in our
deployment every page-registered tool is approval-gated at the user's own
consent surface, *because the page authors the metadata* — a page cannot
decide its own tool is safe. Page-supplied hints (`readOnlyHint`) never
lower that gate; they may only raise scrutiny. We would be glad to write up
the consent-surface experience for the HITL thread if that is useful.

---

## Appendix: the implementation behind the claims

This section is for AgentPort readers and for anyone in the WG who wants
the receipts; it is not part of the paste-ready comment.

**The inversion, stated once.** `docs/NORTH-STAR.md` is the long form: the
site supplies the capability, the user supplies the agent, and the site
never learns which runtime, which model, whose memory, or who pays. WebMCP
is deliberately our input side — `SiteTool` is shaped to converge on it,
and we harvest `document.modelContext` registrations rather than inventing
a second tool-description format.

**The harvest.** `packages/client/src/webmcp.ts#toSiteTool` converts a
registration into a grant entry with `requiresApproval: true` forced on —
the page authored the metadata, so the page does not get to classify its
own tool as safe. The same file's `WEBMCP_NOT_IMPLEMENTED` is our
single-source negative claim: everything in the draft we deliberately do
not implement, each with the reason, updated in the same change as any
behavior move. Two entries relevant to the WG discussion: we record
`readOnlyHint` and read it as *policy* nowhere, and we treat `exposedTo`
as document-scoped because that is what the draft defines — the appendix
ask #3 above is precisely the ambiguity we hit writing that entry.

**The consent surface.** Every string a user reads *in order to decide* —
tool descriptions, approval summaries, origin names — passes the wire's
`display()` validation (control characters rejected, because a
page-authored description carrying terminal escapes once survived to a
consent screen; see AGENTS.md "Wire validation"). Approvals render in
extension-origin chrome a page cannot draw over, and an unanswered window
denies. This is the machinery the paste-ready comment offers to write up
for #165.

**Why we did not ask for per-agent tool registration.** The #116 thread
floats registering *per-agent* tools versus one registry with an
allowlist. Our experience: the site never needs to know *which* agent is
attached (that is the product's core privacy property), so per-agent
registration would be capability we structurally cannot use without
leaking the one thing we exist to protect. An allowlist by *class* is the
strongest thing we can honestly consume, which is why the asks stop there.
