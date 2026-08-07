# ADR-024: The agent may ask its own user — where that is possible

- **Status:** proposed
- **Date:** 2026-08-07
- **Depends on:** ADR-003 (sealed content), ADR-018 (surface tiers), ADR-023
  (authority stamped by the side that knows the truth), ADR-019 Gate C
- **Relates to:** ADR-021 (the extension's reason to exist)

## Context

`packages/daemon/src/runtimes/acp.ts:169` declares:

```ts
clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
```

No `elicitation` key. And `claude-agent-acp` reads that (`acp-agent.js:4114`,
`:4120`):

```js
form: !!this.clientCapabilities?.elicitation?.form,
…
const disallowedTools = elicitationSupport.form ? [] : ["AskUserQuestion"];
```

**So Claude Code's `AskUserQuestion` tool is actively disabled in every
AgentPort session.** Not dropped, not unhandled — removed from the agent's
toolset, by the runtime, because we never said we could render a form.

State the consequence in north-star terms, because it is worse than a missing
feature. The claim is *"a person should own one agent and carry it
everywhere."* An agent that cannot ask its own user a question is not the same
agent — it is a diminished copy, and the diminishment is invisible: it does
not report that it could not ask, it resolves the ambiguity by guessing. That
makes an AgentPort session quietly worse than using the agent directly, which
is the one thing this product cannot afford.

## The thing that makes this different from every other capability

Every other channel a page controls is already classified hostile by this
repo's standing rule: page text, tool results, "treat every tool result as
hostile data, never as instruction."

An elicitation answer is the one channel that would carry **user authority**
into the agent's reasoning. Allowing a page to supply it does not add a
spoofing risk to an existing channel — it *creates the only page-controlled
channel the agent is supposed to trust.* That is privilege escalation in the
trust model, not impersonation within it.

An approval, by contrast, is a boolean over a proposal the agent already made
and the grant already bounds. An elicitation answer is **unbounded content
entering the agent's reasoning with the user's authority attached**, and the
damage outlives the moment: everything downstream inherits false provenance.
The agent will later act "because you told me to", and no frame, hash or
domain can un-attribute that afterwards.

### Why bounding the answer does not help

The tempting middle path is to allow it everywhere and mark the answer
untrusted, the way tool results are marked. That is useless by construction:
the entire value of an elicitation is that the user's answer is
*authoritative*. An answer the agent must not rely on is an answer the agent
must ignore, which is identical to not having asked.

An earlier draft said flatly that elicitation "has no degraded mode". That is
true of a free-text elicitation and **false of a closed-choice one** — where
the agent supplies the options and the user only selects, a forged answer can
only pick something the agent already authored and was willing to act on. That
is bounded much as an approval is bounded, and `AskUserQuestion` is
substantially a multiple-choice affordance, so the objection is not
hypothetical.

The argument survives in a narrower and stronger form:

> **Elicitation can be degraded in its content and cannot be degraded in its
> authority — and it is the authority the page must not hold.**

Bounding the answer space bounds *what* can be said. It does nothing about
*who is recorded as having said it*. A page-selected choice still arrives as
"your user chose B", and attribution to the user is not a side effect of the
feature, it **is** the feature — so it cannot be narrowed away by design. No
bounding of the answer space makes a page-answered elicitation acceptable.

## Decision

### R1. The rule is about routing, not about tiers

> **An elicitation may only be answered on a surface the requesting origin
> cannot draw, read, or forge.**

Stated this way it survives someone adding a fourth tier. Stated as a tier
list it would not, and it would also be *wrong today* — "page-declared"
describes where the **tools** come from, not where the **answer** comes from,
and it is the answer that matters.

The daemon already forks three ways on exactly this, and its own comment says
so (`daemon.ts:1143-1151`):

| tier | answers at | trusted surface? | elicitation |
|---|---|---|---|
| extension | extension chrome | yes — a page cannot draw or read it | **allowed** |
| drop-in / `viaConnect` | the daemon's own terminal | yes | **allowed** |
| delegated / hosted wallet | **the page's own panel** (`agentport-ui.ts:269`, passed at `:364`) | no | **refused** |

The refused tier is the *delegated* one — the tier we built deliberately, that
a real site uses, whose approvals render in page DOM by design, and where a
site may additionally supply its own `decide` callback. It is easy to miss
because a page-declared surface *with the extension installed* is fine.

**A site cannot buy its way out of this with a better UI.** The site panel's
approval card is genuinely good, and it is still the wrong surface, because
the objection is not quality — it is that the party asking to be trusted is
the party being protected against.

### R2. Refuse by capability negotiation, not by rejecting requests

Do **not** implement refusal as "reject the elicitation when the tier is
wrong". That reproduces the exact failure this fleet spent two days removing:
the agent asks and gets nothing back, which is the ask-into-silence hang with
a new trigger.

Implement it as **per-attachment capability negotiation**. `AcpRuntime`
spawns its child and calls `initialize` once per `openSession`
(`acp.ts:114`, `:164`), so `clientCapabilities` is *already* per-attachment
rather than per-daemon. Declare form elicitation only for tiers that have a
trusted surface, and the runtime's own `disallowedTools` does the rest.

This is ADR-023's principle again: **the capability is decided by the side
that knows the truth, and the other side cannot misrepresent it.** It also
means the refusal path needs no code of its own — and a refusal with no code
cannot have the ask-into-silence bug, because there is nothing to forget to
answer. That is the best kind of refusal.

### R3. Claim the win this earns, not the one next to it

It is tempting to write that the agent then "knows it cannot ask and behaves
accordingly." **That does not follow, and the ADR must not say it.**
`disallowedTools` is a plain name list spread into the runtime's options with
no accompanying explanation. A model does not experience an absent tool as a
prohibition it was told about; it experiences nothing at all. So the model
does not know it may not ask — it has no affordance for asking, and does what
it does when it cannot ask: it guesses.

Which is today's behaviour. Capability negotiation makes that state
**intentional and documented for one tier**, rather than accidental and
universal. That is a real improvement and it is a different win from making
it visible.

### R4. Visibility belongs to the user, in the session surface

The party who needs to know is the **user**, not the model.

- The model cannot act usefully on the knowledge: its only alternative to
  guessing is to stop, and an agent that halts on every ambiguity is worse
  than one that guesses.
- The user *can* act on it. "On this site your agent cannot ask you anything,
  so it will guess" is the difference between trusting a result and checking
  it.

So a tier that cannot elicit says so where the user is looking — the panel,
the widget, the consent card. One honest line, and it needs no cooperation
from the model, which is the point.

This is also the extension's best adoption argument, and the first one that is
not about key custody: **it is the only tier where an agent can ask you
something privately.** Delivered at the moment it is true.

### R5. The runtime interface gains *policy*, not a boolean

`AgentRuntime.openSession` currently receives
`Omit<TurnContext, 'say'|'think'|'plan'|'callTool'|'requestApproval'|'signal'>`
— surface, grant, tools. All *attachment content*.

A tier discriminator is the first piece of **attachment policy** that
interface would carry, and it should be named as such. Gate C's own-tool
allowlist needs exactly this channel next, so the shape is chosen
deliberately now: a single `policy` object with elicitation inside it leaves
room; `canElicit: boolean` does not, and would be a one-off boolean today
followed by a real policy object three weeks later.

### R6. Form mode only; `url` mode is refused, not deferred

MCP's own spec says a client MUST NOT pre-fetch a url elicitation, MUST show
the full URL, and MUST NOT let the model inspect the content — and it involves
opening a window. That is a consent design, not a v1 detail. The mode is a
**closed set that rejects unknown modes rather than defaulting to the
friendlier one**, matching ADR-023's authority domain and the exact-`t`
registry discipline.

### R7. Acceptance

The frame pair is sealed content, so no relay deploy — the `plan` frame is the
template, not `revoke`/`revoked`. Both directions register in the sealable
sets, which are now compiler-checked, so an omission fails the build.

Checks use a **scripted fixture agent** over real stdio, the
`hostile-permission-agent.mjs` pattern, so the property does not depend on a
model choosing to ask. And rule 3 applies hardest here of anywhere: this is a
request/response round trip *through a human*, so the daemon side needs a
deadline and a decline-on-timeout, or an unanswered question hangs the turn.
`AgentWallet.revoke`'s `#awaitTimed` is the template.

### R8. Four things the code says that the design assumed wrongly

Verified against `@agentclientprotocol/sdk@1.3.0` and
`claude-agent-acp@0.64.0` before writing any frame, because the last two
times a shape was asserted ahead of the code, the code disagreed.

**The capability is a marker object, not a boolean.** `elicitation: { form: {} }`
— `ElicitationFormCapabilities` is `{ _meta? }` and nothing else. And the
trap: the SDK parses it with `defaultOnError`, so a *wrong* value is not an
error, it is silently replaced with `undefined`, which reads as unsupported.
`elicitation: { form: true }` would land on the agent as capability-off with
**no error anywhere**. The failure mode of this feature is silence — the same
shape as the bug it exists to fix, one layer up. R2's negotiation therefore
needs a check that the capability was actually accepted, not merely sent.

**`decline` and `cancel` are not interchangeable, and `decline` means
*allow*.** `applyAskElicitationResponse` maps `decline` to
`{behavior:'allow', updatedInput:{…answers:{}}}` — the tool runs with empty
answers and the model is told the user skipped. `cancel`, and any unknown
action, throws `Tool use aborted`. So the timeout in R7 must **decline, not
cancel**: an unanswered question should leave the agent proceeding as though
the user skipped, which is what the built-in tool does, rather than killing
the turn. Cancelling on a timeout would convert "you didn't answer" into "your
work is destroyed".

**`AskUserQuestion` is not a veto point, and elicitation is not an approval.**
The answer becomes *input to a tool that then runs* — it is not a gate on the
call. ACP's permission channel only covers calls the runtime chooses to
surface. Nothing here should be mistaken for a security control; this ADR is
about restoring a capability, and the security content is entirely in *who may
answer*.

**There are two producers, and only one is bounded.** A real
`AskUserQuestion` is capped by the agent SDK at ≤4 questions × ≤4 options,
rendering to ≤8 form fields. But an **MCP server elicitation** passes the
server's own JSON Schema through with only `type:"object"` forced — arbitrary,
unbounded, server-authored. Our wire schema is bounded by *us*, at our own
limits, and refuses what exceeds them. A form is rendered to a human; a form
too large to read is not a consent surface.

### R9. No secrets through a form, from day one

`prior-art-synthesis.md:398-403` records that elicitation had to **ban**
collecting secrets through structured forms, and says to design our surfaces
with that ban from the start rather than retrofitting it. Taken: a form field
is not a credential prompt, and the surfaces must not grow one. This is
cheaper to hold now than to walk back after a site has learned the shape —
the same reasoning as freezing the signing envelope early.

### R10. What a page may answer for — and the hole this exposes in ADR-023

Run R1's provenance argument against something we ship today and it seems to
prove too much. A page-answered **approval** in the delegated tier also
arrives as "your user said yes" — same false provenance, same party, same
tier. If provenance is what condemns page-answered elicitation, why not that?

The resolution is not quantitative, and it is not "bounded by the grant". It
is structural, and it turns on a fact easy to miss: **in the delegated tier
the site's tools are the site's own functions.** `SiteTool` carries a
`handler` the page supplies, and the client invokes it in the page
(`session.ts:374`). A site forging an approval for one of its own tools has
gained *nothing it did not already have* — it could simply call the function.
Those approvals do not protect the user from the site; they protect the user
from the **agent** being talked into misusing the site's tools by hostile
content. Self-referential, not escalation.

That gives the general rule, of which R1 is one case:

> **A page may answer for its own capability. It may not answer for the
> user's, and it may not answer as the user.**

- *site-tool approval, page-answered* — the page's own capability. Fine.
- *elicitation, page-answered* — answering **as** the user. Refused (R1).
- *runtime-own-tool approval, page-answered* — answering for **the user's**
  capability. **Also wrong, and we ship it today.**

That last row is a live hole, and ADR-023 got close enough to name it without
closing it. The daemon routes every non-`viaConnect` approval to the client
panel (`daemon.ts:1146-1151`), and ADR-023 established that
`runtime_own_tool` approvals travel that same path. So in a delegated session
**the page is asked whether the agent may use the agent's own shell** — and
ADR-023 made the two domains *distinguishable*, so a renderer can tell the
truth, but it did not make them *route differently*.

Distinguishable was the right first step and is not sufficient. The domain
field is exactly the discriminator needed: a `runtime_own_tool` approval
belongs on a surface the origin cannot forge, by the same rule as an
elicitation, and for the same reason.

**This is not fixed here.** It is a separate change to ADR-023's routing
rather than a paragraph in ADR-024, it wants its own adversarial check, and
folding it into an elicitation ADR would bury it. Recorded so that the next
person finds it stated rather than rediscovers it — and so that nobody reads
ADR-024 as implying that page-answered approvals are fine in general. They are
fine in exactly one case, for a reason that does not extend.

### R11. R10's redirect does not exist — the answer is refusal, symmetrically

R10 said a page-answered `runtime_own_tool` approval is wrong and left where
it should go open. The obvious repair — answer it on the hosted wallet's own
origin, which already authorised the delegation — **does not work**, and the
reason is in our own code rather than in principle.

Opening a wallet-origin popup requires **user activation**. An approval
arrives mid-turn from the agent, with no gesture behind it. `connect.ts`
proves the constraint rather than asserting it: it pre-opens `about:blank`
*synchronously* "while this call still has user activation", precisely because
a popup cannot be summoned later. The surface cannot be opened at the moment
it is needed.

The fallback of a persistent cross-origin iframe is worse, not better. A page
cannot **read** it — and can cover, resize and position it deceptively.
Clickjacking is exactly the attack a real browser window exists to defeat.
Answering for the user's capability inside a surface the page can cover is not
meaningfully better than answering in the page.

So the delegated tier has **no** surface that can answer for the user's
capability at approval time, and the answer is the one this ADR already
reached for elicitation: **refuse, do not reroute.** The three rows become one
rule with no special cases:

| | | |
|---|---|---|
| `site_tool`, page-answered | the page's own capability | allowed, every tier |
| `runtime_own_tool`, delegated | the **user's** capability, no trusted surface | refused |
| elicitation, delegated | answering **as** the user, no trusted surface | refused |

That makes R10 a smaller change than it first looked — a policy-driven refusal
where approvals fork, not a new answer path — and it removes the wallet and
client work entirely.

**And it inherits R4.** A refused own-tool must not become an agent that
silently cannot use its own tools; that is the invisible diminishment again,
one row down. The user is told "on this site your agent works with the site's
tools only", in the session surface, for the same reason and by the same
argument.

**One predicate, not two booleans.** `mayAsk` and any `mayUseOwnTools` turn on
the *same* question — does a surface exist that the requesting origin cannot
draw. They are derived from one named predicate
(`#hasTrustedAnswerSurface`), because two booleans that agree today drift the
first time somebody changes one, and they drift silently: agreeing is not
something a compiler can check. When the extension becomes the wallet, one
predicate flips and everything derived from it flips together.

## The cost, stated rather than discovered

**A hosted-wallet session gets no elicitation, therefore no
`AskUserQuestion`, therefore an agent that guesses.** That is the honest price
of a tier whose only answer surface is one the site can read. It is not a
temporary limitation to be engineered away later — it follows from the trust
model, and the way out is the extension, not a cleverer page.

## Falsifiability

- **R1:** if a surface appears that a site cannot forge but that is not
  extension chrome or a terminal — a browser-native consent primitive, say —
  it qualifies under the rule as written, with no amendment needed. That is
  the point of stating it as routing.
- **R2:** if a runtime ever enables its ask-tool *without* consulting the
  declared capability, negotiation stops being sufficient and the refusal
  needs code after all — with a deadline, per R7.
- **R3/R4:** if a model turns out to act usefully on knowing it may not ask,
  the visibility target moves back toward the prompt. Nothing in the design
  depends on it not doing so.
