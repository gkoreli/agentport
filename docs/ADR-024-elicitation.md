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

### Why there is no degraded mode

The tempting middle path is to allow it everywhere and mark the answer
untrusted, the way tool results are marked. That is useless by construction:
the entire value of an elicitation is that the user's answer is
*authoritative*. An answer the agent must not rely on is an answer the agent
must ignore, which is identical to not having asked.

Compare an approval, which degrades gracefully in three directions — ask more
often, ask in a worse surface, ask about smaller things — and is still an
approval in every one. **Elicitation has no such knob.** So the choice is
have-it or refuse-it, and refusal is forced rather than chosen.

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
