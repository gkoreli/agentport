# ADR-021: The web harness — your own agent drives any website

- **Status:** proposed
- **Date:** 2026-08-06
- **Depends on:** ADR-006 (WebMCP harvest), ADR-008/009 (extension tiers and
  custody), ADR-018 (security architecture), ADR-019 (hardening gates)
- **Supersedes in part:** the assumption, implicit in the extension today, that
  a widget session is a lesser thing than a page-declared one

## Context

AgentPort's clean case is a site that opted in: it declares tools, or registers
them with WebMCP, and the user's agent borrows them. Most of the web will never
do that.

The extension can supply the missing half. It already ships generic page tools
— `page.info`, `page.readText`, `page.readSelection`, `page.listElements`,
`page.scroll`, `page.fill`, `page.click`
(`packages/extension/src/pagetools.ts:125`) — and lends them to the user's
agent on any site, through the same grant, consent, and sealing machinery as a
declared surface. We call that surface the **widget**
(`packages/extension/src/bridge.ts:100`: `type Origin = 'page' | 'widget'`).

That is not a fallback. It is the widest form of the product: **the same agent
you already run — your memory, your prompts, your MCP servers, your files —
now able to see and act on the page in front of you.** Browsers are shipping
assistants that live in the browser and know nothing about you. This is the
opposite: the agent you already brought everything to, reaching one more place.

Two things stop it from being usable today, and both were found by using it
rather than reading it.

**A navigation kills the session.** The agent is asked to click a link; it
succeeds; the document goes away and the attachment dies with it. This is not
an oversight — it is written down (`packages/extension/src/sw.ts:725`):

```js
// The extension's own widget sessions die with their document — only
// page surfaces navigate and come back.
if (entry.from === 'page') orphanSession(entry);
else dropSession(entry, 'frame_closed');
```

Page-declared surfaces get the orphan-and-reclaim path with a two-minute grace
(`sw.ts:224`); the widget does not. So the one surface whose entire purpose is
driving multi-page flows is the one surface that cannot survive succeeding.

**Every call re-asks.** `askApproval(origin, who, prompt)` (`sw.ts:161`,
`:525`, `:608`) opens an extension-chrome window per call, and nothing is
remembered between them. On a declared site with a handful of gated tools that
is proportionate. On a generic harness where the agent clicks, reads, clicks
again, it is a modal dialog every few seconds, which trains the user to approve
without reading — the worst possible outcome for a consent boundary.

## Decision

Build the widget into a real harness. The organizing idea:

> **The attachment belongs to the user and the origin, not to the document.**

A document is an implementation detail of a visit. Everything below follows
from taking that seriously.

### 1. Sessions survive navigation

Widget sessions get the orphan-and-reclaim treatment page surfaces already
have, keyed on `(user, origin)` rather than the port. Same-origin navigation
reclaims the live session; the agent's conversation, its ACP session, and the
grant continue across the boundary.

Cross-origin navigation does **not** silently carry the attachment. The origin
is the consent unit — carrying a grant from one origin to another would let a
link hand the agent to a site the user never approved. Leaving the origin
detaches, and returning re-attaches within the grace window without re-asking.

Delete the `entry.from === 'page'` discrimination in the disconnect path; there
is one lifecycle, not two.

**Open:** whether a tab-scoped or origin-scoped identity is the right key when
the same origin is open in several tabs. Prefer origin-scoped with the tab as a
tiebreaker for reclaim, matching `reclaimSession` (`sw.ts:257`).

### 2. Navigation is a first-class tool, not an accident

If the harness is going to drive multi-page flows, the agent should be able to
say where it is going: a `page.navigate` tool, and a way to await the load and
observe that the page changed underneath it. Today navigation is something that
*happens to* the agent mid-turn, and it finds out by its next tool call failing
(`sw.ts:654`: "the page is navigating; retry in a moment").

The agent must also be told the page changed. A tool result that silently
describes a different document than the one the agent reasoned about is the
kind of confusion that produces wrong actions.

### 3. Consent is remembered — for attaching and reading, NOT for mutating

**This section was rewritten after an independent security review
(`docs/reviews/web-harness-consent.md`) rejected the original proposal.** What
follows is the corrected model; the original is described below so the
reasoning is not lost.

What was proposed: remember approval per origin *and per action class*, so a
user could say "allow clicks on this site" and stop being asked. That is
unsound, for reasons that survive every scoping refinement:

- **`click` is not a security class.** One click can navigate, purchase,
  publish, authorize, send, or delete. A count of one is already enough for an
  irreversible effect.
- **`fill` is already data egress, not a step before it.** `page.fill`
  dispatches bubbling `input` and `change` events that the page's own scripts
  observe (`packages/extension/src/pagetools.ts:164`, `:181`). By the time an
  "always ask before Submit" policy could fire, the value has already been
  transmitted. The attack is: hostile page text tells the agent to place data
  it holds into a field; remembered `fill` writes it; the page's listener sends
  it; no later approval ever fires.
- **The labels the agent reasons about are attacker-controlled** — ARIA
  attributes, placeholders, names, text (`pagetools.ts:65`) — and the element
  handle proves only that the same object is still connected, not that its
  meaning, handlers, or form destination are unchanged (`pagetools.ts:92`).

So: **remember attachment and passive observation, not mutation.**

- **Remembered:** permission to attach the chosen agent with the read-only
  tools — `page.info`, `page.readText`, `page.readSelection`, metadata-only
  `page.listElements`, `page.scroll`.
- **Always re-asks, with no remembered policy able to satisfy it:** every
  generic fill, click, submit and navigation; anything uploading, downloading,
  touching the clipboard, credentials, accounts, authorization, money, or
  anything externally visible; any transfer of the agent's memory or local data
  into a page; and any action whose provenance or impact class is unknown.
- **Scope:** exact HTTPS top-level origin, the selected agent device key, the
  tab, the top frame, the active document epoch, and a policy version. No
  wildcard subdomains, no remembered iframe authority.
- **Activation:** a user gesture per tab. A remembered policy must never cause
  the agent to start or resume a run merely because the user visited a site.
- **Lifetime:** session storage; expires at browser-session end or eight hours,
  whichever is first, with a 15-minute idle and one-hour hard expiry per
  attachment, none of them rolling.
- **Visible and revocable:** the origins-holding-your-agent list, atomic
  revocation, a kill-all, and bounded local audit metadata — timestamp,
  verified origin, agent, action class, decision. Never prompts, arguments,
  results, page text, query strings, or tokens.

**A separate finding that changes the API, not just the policy.** Gated page
calls and the runtime's OWN tool-permission requests currently pass through the
same untyped boolean decider: `ApprovalPrompt` carries a summary and an
optional call and no provenance at all
(`packages/client/src/session.ts:59`), and both `tool.call` and
`approval.request` route into it (`session.ts:253`, `:346`), including ACP's
own-tool permission request (`packages/daemon/src/runtimes/acp.ts:328`). So a
remembered policy implemented as "a smarter askApproval" could match an
approval that was never about the page at all. Any remembered policy therefore
requires an extension-trusted authority domain on every approval —
`generic_page_tool`, `site_declared_tool`, `runtime_own_tool`, `navigation`,
`data_egress` — and a runtime-own-tool approval must never be satisfiable by an
origin's page policy.

**Scopes that are real, and scopes that are theatre.** Tab, top frame, and
document epoch are required. Exact origin is necessary but insufficient on
origins hosting mutually distrusting content. Absolute and idle time limit how
long a compromise stays useful. Count and rate do not protect against the first
destructive action. Route and path are SPA-controlled and are context, not
authority. A remembered "next five actions" is theatre unless the sequence is
exact, immutable, single-use, and aborts on any change.

### 4. Site tools win where they overlap

Where a site declares tools — natively or via WebMCP — those are preferred
over synthesized clicks, because a named action carries intent and a click
carries a guess. The harness fills what the site left undeclared. The user
should not have to know which case they are in, and the grant should make the
distinction visible without making it the user's problem.

### 5. The harness is only as good as its failure modes

Generic page tools are what the agent falls back on when a site says nothing,
so their weaknesses are the product's weaknesses. Wanted, in priority order:

- **Element addressing that survives a re-render.** A framework re-rendering
  between `page.listElements` and `page.click` must not silently retarget.
- **Truthful failure.** "Clicked" must mean something happened; a click into a
  detached node must report that, not succeed quietly.
- **Bounded, structured reads.** `page.readText` on a large document must
  degrade predictably (`MAX_TEXT` / `MAX_ELEMENTS` exist at
  `pagetools.ts:20-21`) and say that it truncated.
- **Waiting.** Real flows need "wait until this appears" more than they need
  more verbs.

### 6. Prompt injection is the hard problem here, and it gets worse

On a declared surface, the site chose what to expose. On an arbitrary page,
**the agent reads attacker-controlled text while holding tools over that same
page** — and now, with remembered consent, some of those tools do not stop to
ask. That combination is exactly what ADR-019 Gate C names as unfinished.

Non-negotiable consequences:

- Page text reaches the agent as **data, never instruction**. This must be
  explicit in what the daemon hands the runtime, not assumed.
- Remembered approval is scoped by **action class and origin**, never "the
  agent may now do anything here". The blast radius of a successful injection
  is the class the user approved on the origin they approved it for.
- Anything crossing an origin, spending money, or being externally visible
  keeps an explicit approval regardless of what was remembered.
- The reverse capability firewall (ADR-019 Gate C: scoping the agent's *own*
  tools per session) becomes more urgent, not less. A poisoned page must not be
  able to talk the agent into reading the user's home directory, and today
  nothing stops it.

## Consequences

**Good.** AgentPort becomes usable on the entire web instead of the part that
opted in, and the pitch gets much sharper: not "sites can add an agent" but
"your agent works on every site you already use". It also produces the strongest
possible reason for a site to declare tools — its own named actions beat the
generic harness — which feeds the WebMCP direction rather than competing with
it.

**Costs.** Remembered consent is a real reduction in per-action friction, and
friction was doing some security work. It has to be replaced by scoping,
visibility, revocation, and injection containment rather than by trust. If we
ship remembered approval without the containment, we have built a
one-click-hijack machine, and that would be worse than shipping nothing.

**Not decided here.** Whether the harness should offer a recorded/replayable
flow; whether cross-tab attachments share one session; naming for the widget.

## Ship order

The review's ordering, adopted. Per-call approval for every mutation stays on
throughout; remembered mutation sits behind a flag that is not available, not
behind a weaker fallback.

1. **Navigation survival and truthful page tools** — the parts with no consent
   implications. Widget sessions orphan and reclaim across same-origin
   navigation; cross-origin detaches; a click that did not happen says so.
2. **Separate the authority domains.** Every approval carries an
   extension-trusted domain tag. Nothing can be remembered until an approval
   can say what kind of authority it is asking for.
3. **Runtime containment (ADR-019 Gate C).** The agent's own filesystem, shell,
   mail, browser, credential and network tools are absent by default for an
   attachment, and a runtime that cannot enforce that is refused.
4. **Fix the read boundary.** Truthful visible-text extraction, no ordinary
   form-value disclosure, document-bound handles, conservative revalidation.
5. **The navigation state machine** — top-frame identity, frame and document
   ids, final committed origin, epochs, redirects, SPA notifications, and
   cancellation at navigation start.
6. **Trusted policy UI, storage, atomic revocation, kill-all, audit view.**
7. **Adversarial browser tests** — hidden injection, input-event exfiltration,
   changed click handlers, same-origin iframe reclaim, redirects, pushState,
   meta-refresh, opaque documents, revocation races, worker eviction,
   cross-tool local-data exfiltration.
8. **Independent review of the release candidate.** Only then enable remembered
   READ-ONLY consent.

Remembered generic writes stay out of scope until there is a materially
stronger semantic authorization design than "the user said clicks are fine
here".
