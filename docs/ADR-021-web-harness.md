# ADR-021: The web harness — your own agent drives any website

- **Status:** accepted; ship-order 1, 2 and 4 delivered (navigation
  survival and truthful page tools, separated authority domains, the read
  boundary). 3 is ADR-019 Gate C and is blocked; 5-7 outstanding, and
  `page.navigate` is still proposed rather than built.
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
(`packages/extension/src/pagetools.ts#genericPageTools`) — and lends them to the user's
agent on any site, through the same grant, consent, and sealing machinery as a
declared surface. We call that surface the **widget**
(`packages/extension/src/bridge.ts#Origin`: `type Origin = 'page' | 'widget'`).

That is not a fallback. It is the widest form of the product: **the same agent
you already run — your memory, your prompts, your MCP servers, your files —
now able to see and act on the page in front of you.** Browsers are shipping
assistants that live in the browser and know nothing about you. This is the
opposite: the agent you already brought everything to, reaching one more place.

Two things stop it from being usable today, and both were found by using it
rather than reading it.

**A navigation kills the session.** The agent is asked to click a link; it
succeeds; the document goes away and the attachment dies with it. This is not
an oversight — it was written down, in `packages/extension/src/sw.ts`, in the
disconnect path this ADR deleted:

```js
// The extension's own widget sessions die with their document — only
// page surfaces navigate and come back.
if (entry.from === 'page') orphanSession(entry);
else dropSession(entry, 'frame_closed');
```

Page-declared surfaces got the orphan-and-reclaim path with a two-minute
grace; the widget did not. So the one surface whose entire purpose is driving
multi-page flows was the one surface that could not survive succeeding.

**Every call re-asks.** `askApproval` (`packages/extension/src/consent-windows.ts#askApproval`,
now `(origin, who, prompt, synthesised)`) opens an extension-chrome window per
call, and nothing is remembered between them. On a declared site with a handful of gated tools that
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
tiebreaker for reclaim, matching `reclaimSession` (`packages/extension/src/sw.ts#reclaimSession`).

### 2. Navigation is a first-class tool, not an accident

If the harness is going to drive multi-page flows, the agent should be able to
say where it is going: a `page.navigate` tool, and a way to await the load and
observe that the page changed underneath it. Navigation used to be something
that merely *happened to* the agent mid-turn — it found out when its next tool
call failed. Ship-order 1 replaced that with a bounded wait for the document to
rebind (`packages/extension/src/sw.ts#awaitRebind`), which is a better failure
and still not an affordance: the agent still cannot say where it is going.

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
  observe (`packages/extension/src/pagetools.ts#genericPageTools`). By the time an
  "always ask before Submit" policy could fire, the value has already been
  transmitted. The attack is: hostile page text tells the agent to place data
  it holds into a field; remembered `fill` writes it; the page's listener sends
  it; no later approval ever fires.
- **The labels the agent reasons about are attacker-controlled** — ARIA
  attributes, placeholders, names, text (`packages/extension/src/pagetools.ts#ElementRow`) — and the element
  handle proves only that the same object is still connected, not that its
  handlers or form destination are unchanged — it does now refuse when the
  role or label moved (`packages/extension/src/pagetools.ts#resolveHandle`).

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
same untyped boolean decider: `ApprovalPrompt` carried a summary and an
optional call and no provenance at all, and both `tool.call` and
`approval.request` routed into it, including ACP's own-tool permission
request. That was ADR-023's subject, and it shipped — the prompt now carries an
authority domain (`packages/client/src/session.ts#ApprovalPrompt`). At the time,
though, a
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
so their weaknesses are the product's weaknesses. Wanted, in priority order —
and three of the four have since shipped, marked here rather than left reading
as an open wish-list:

- ~~**Element addressing that survives a re-render.**~~ **Done.**
  `packages/extension/src/pagetools.ts#resolveHandle` refuses the call when the
  element's role or label changed since it was listed, rather than retargeting
  silently.
- ~~**Truthful failure.**~~ **Done.** `page.click` consults
  `packages/extension/src/pagetools.ts#obstruction` and says what is covering
  the element; `page.fill` returns `applied` (the value really is what we set)
  separately from `stable` (the DOM stopped changing), because a write that
  the page reverted is not a write that failed.
- ~~**Bounded, structured reads.**~~ **Done.** `MAX_TEXT` / `MAX_ELEMENTS` at
  `packages/extension/src/pagetools.ts#MAX_TEXT`, and both readers return
  `truncated` — an agent that reads an excerpt and does not know it was an
  excerpt draws conclusions the page never supported.
- **Waiting.** Still open, and still the one that matters most. `#settle`
  exists but answers "has the DOM stopped moving", which is not the question:
  real flows need *wait until this appears*, and without it the agent's only
  tool for a slow page is to read it again and hope.

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
