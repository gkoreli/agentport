# ADR-023: An approval says what it is for

- **Status:** proposed
- **Date:** 2026-08-06
- **Depends on:** ADR-003 (approval frames are sealed content), ADR-019 Gate B
  (wire schemas) and Gate C (runtime containment), ADR-022 (the same theme:
  granted authority, bounded and verifiable)
- **Blocks:** ADR-021's remembered consent, which may not ship until approvals
  carry an authority domain
- **Build order:** item 2 in `docs/reviews/prior-art-synthesis.md`, directly
  after revocation

## Context

The consent review found that gated page calls and the runtime's own-tool
permission requests "pass through the same untyped boolean `ApprovalDecider`"
with no authority-domain or provenance field. That is true, and it is worse
than it sounds. Traced end to end:

`ApprovalPrompt` (`packages/client/src/session.ts:60`) has exactly two fields,
`summary` and an optional `call {name, arguments}`. Two producers reach one
consumer:

- `#onToolCall` (`session.ts:331`) — a **site tool from the signed grant**,
  gated by `requiresApproval` or `alwaysAsk`. Its `call.name` is a granted,
  namespaced tool name.
- `#onApproval` (`session.ts:405`) — an `approval.request` frame, passed
  through verbatim.

Both call `this.#decide(prompt)`. The ACP runtime's own-tool permission
requests land on the second path (`packages/daemon/src/runtimes/acp.ts:377`),
and the name they carry is:

```ts
name: params.toolCall.title ?? 'tool',
```

**That is agent-chosen text, not a name from the grant.** Agent titles are
influenced by page content, which this project treats as hostile by standing
rule. So the two kinds of request are indistinguishable to whoever answers,
and the one that is *not* bounded by the grant is the one whose label an
attacker gets to choose.

### The part that makes this urgent is not auto-approval

The obvious attack — a decider that auto-approves on grant membership, walked
past by an own-tool request titled after a granted tool — does not work
against the extension today. `askApproval` in `packages/extension/src/sw.ts`
never branches on `call.name`, never consults grant membership, and has no
auto-approve path: it opens an extension-origin window and waits for a human.
(The `toolNames.has(name)` checks at `sw.ts:893` and `:902` are the *dispatch*
grant boundary, correctly placed; an own-tool request never reaches them
because it is not a `tool.call`.)

The real problem is one layer up, and it is worse. The consent window renders
(`packages/extension/src/consent.ts:127`):

```
${state.agentName} asks: ${state.summary}
<pre>${JSON.stringify(state.call.arguments)}</pre>
```

The summary shown to the human **is the text the request carried**. So an
own-tool permission request whose title is agent-chosen can be made to read
exactly like a granted site tool, displayed inside the one window a page
cannot draw, above the arguments of what is actually the agent's own shell.

The extension does not auto-approve it. It does something no better: it asks
the human a question that misrepresents what they are approving, in the
surface whose entire security value is that the page cannot forge it. We built
a trustworthy window and are prepared to render untrustworthy text in it. A
user who has learned this window is the reliable one is exactly the user who
will approve.

That reframes the fix. An authority domain is not only an input to a policy
engine that does not exist yet — **it is a thing the consent window must
say.** "Your agent's own tool" versus "a tool inkwell.test lent it" is the
distinction a human needs to answer the question at all, and today the window
cannot draw it because the information does not exist by the time it renders.

## Decision

### R1. `ApprovalRequest` carries a closed-set authority domain

An enum, not a string. An open string is another field a peer self-declares,
and the exact-`t` registry discipline already says what to do with an open
vocabulary: close it. Initial set, following the consent review's own
division: `site_tool` and `runtime_own_tool`. Others (`navigation`,
`data_egress`, `generic_page_tool`) are ADR-021's to add when the harness
needs them; adding a member is a schema change, which is the point.

**The sizing rule is the rendering rule**, and it is the reason the set starts
at two rather than the review's five: every member must have an honest
one-clause sentence a human recognises. "Your agent's own tool" and "a tool
inkwell.test lent it" are the strings that let someone decide;
`runtime_own_tool` is not. The enum is the wire form and the human text lives
in the consent surface — but *if a member cannot be explained in one clause,
it is probably two domains.* A vocabulary that outgrows its renderer is how
fine-grained consent decays into click-through, which is the failure the
prior-art synthesis records for every system that tried it.

### R2. The daemon stamps the domain; the runtime never declares it

Same rule as the relay stamping client identity (invariant 3): a self-reported
field is not a field. And here the reasoning is sharper than the analogy — the
runtime is precisely the party that cannot be trusted to classify its own
request, because its title text is already page-influenced. A runtime that
could label its own shell invocation `site_tool` would defeat the field in one
line.

### R3. An unrecognised domain is refused, never defaulted

A client that does not understand a domain declines rather than falling back.
Defaulting is how a newly added domain silently inherits the weakest existing
policy — the failure mode ADR-021 would otherwise walk into the first time it
adds one.

### R4. The domain must be displayed, not merely carried

A domain nobody renders only helps a policy engine that does not exist yet.
The consent window states which domain it is asking about, and page-supplied
text is identified as page-supplied. This half is the extension's lane and
ships in the same wave, not after.

### R5. What gets stamped when the two could overlap

Explicitly, because the next reader will wonder: a granted tool's *invocation*
can only arrive through the MCP bridge. `turn.callTool` is reachable only from
the invoker the bridge registers (`acp.ts:163`), and the bridge only registers
the session's granted tools — so a granted call always meets the browser gate
in `#callTool` and is stamped `site_tool`. The ACP permission path for a
granted tool is short-circuited before it ever reaches `turn.requestApproval`
(`acp.ts:365`, exact-name match against the grant, allow-once only).

The residual edge is a name-normalisation mismatch: a granted tool announced
under a name `mcpToolName()` does not produce would fall through and be
stamped `runtime_own_tool`. **That stamp is correct.** The domain describes
the path a request arrived on, not the identity it claims — which is the whole
property, given the alternative is trusting a name.

### R6. Binding: name the property that is load-bearing, and refuse the theatre

This ruling was written three times, and the path is worth keeping because
each version was wrong in a different direction.

*Draft one* scoped the binding down to insurance, reasoning that `id` is a
fresh handle so replay is unreachable. *Draft two* scoped it up after finding
that `packages/daemon/src/runtime.ts:127-138` calls `writer.args(text)` twice
— once to build the approval, once to build the dispatch — so the object the
user approved is discarded and a freshly built one crosses the wire. *Draft
three*, after review, is the correct one, and it needs four separate
statements because the paths do not share an answer.

**Replay is dead, and not for the reason draft one gave.** The
`approval.response` handler does `get` → `if (!pending) return` → `delete` →
`resolve`, and the abort path uses `if (!session.approvals.delete(id)) return`
— *delete's boolean is the interlock.* So a second response carrying the same
id finds nothing and a timeout racing a response cannot double-resolve. The
property holds because of **delete-before-resolve ordering with the map as the
single source of liveness**, not because the id is unguessable. That
distinction matters: a future refactor that resolves first and deletes after,
or that keeps answered ids for idempotency, kills it silently and every test
still passes. **Nothing today asserts that a second response is ignored.** It
will, in this change.

**The enforcement gate on the site-tool path is already bound.** Draft two
overstated `runtime.ts`: that `requestApproval` is a runtime's *own advisory*
prompt, not the gate. The gate is client-side `#onToolCall`, which renders and
dispatches the same `arguments` reference in the same tick. The double
`writer.args(text)` is a footgun in the reference runtime — worth removing so
nobody copies it — not a bypass.

**The ACP own-tool path has a real gap that no field on any frame can
close.** We show the user `params.toolCall.rawInput` and answer the agent with
a bare `optionId`; the runtime then does whatever it does. The approval is
over *text the runtime authored*, not over a bound action. That is a
containment problem (ADR-019 Gate C), not an approval-frame problem.

**Therefore the digest ships, and the record says what it does not do.** It
gives approval→response integrity and binds every call AgentPort itself
dispatches. It does **not** bind the runtime's own execution, and the failure
mode to guard against is precisely that the next person adds a hash, feels
safer, and has changed nothing about the one path that actually lacks
binding. A field that produces confidence without producing a property is
worse than an absent field, because it stops the search.

### R7. Two corrections to inherited instructions, recorded rather than silent

**The build order's "deploy relay first" does not apply here.**
`prior-art-synthesis.md:606-608` says this change needs the relay deployed
first. That is the right general rule and the wrong call for these two frames:
`approval.request` is in `AGENT_SEALABLE_MEMBERS` and `approval.response` in
`CLIENT_SEALABLE_MEMBERS`, neither is a lifecycle frame, and `grep -rn
"approval" packages/relay/src/` returns nothing. The relay sees `{t:'enc',…}`
and routes on `s`. Endpoints deploy together; **the relay is not in that set.**

**The consent review's line refs are stale.** It cites `session.ts:59`,
`:253`, `:346` and `acp.ts:328`; the live equivalents are `session.ts:60`,
`:338`, `:408` and `acp.ts:379`. Cite the live ones.

**And a latent liveness bug found on the way**, worth fixing in the same
change: `acp.ts:383` puts `params.toolCall.title` into `call.name`, which the
schema validates against `TOOL_NAME_PATTERN`. A title containing any character
that pattern forbids does not degrade — it rejects the whole frame, so the
user is never asked and the agent's permission request hangs on a `Deferred`
until the turn aborts. A human title does not belong in a tool-name field.

### R8. A throw inside a request handler becomes the peer's hang

`#requestPermission` is registered with `.onRequest`. `seal()` validates its
own output before encrypting — correct, so a frame the far end would reject
fails at the sender as a local bug rather than tearing down the peer's
session. But inside a request handler that throw never reaches the wire: the
agent waits for a permission response that will never come, until the turn
aborts. **Loud at the sender is silent on the wire, and the wire is where the
peer is waiting.**

The title fix above removes today's reachable cause. It does not remove the
class — an over-long summary, an arguments object past the JSON node bound, or
a runtime that namespaces tool names differently all reach the same throw. So
the handler now converts an internal failure into a **denial with a logged
reason**. Denying is the honest answer, because the user was never asked.

This is the third shape of one disease, and all three are now written down:

1. **A handler set the compiler cannot check** — a message arrives and nobody
   is listening. Four instances in one day; three are now compile errors and
   the fourth (per-call waiter lists, which have nothing to be total over) is
   covered by a liveness backstop instead.
2. **A check that hangs rather than fails** — a hang is indistinguishable from
   slowness, so nobody waits to find out. Every path that can refuse, deny or
   time out needs its own deadline.
3. **A throw inside a request handler** — a message never leaves and the peer
   is listening forever.

All three are the failure path being incomplete while the happy path is fine.

### R9. One property this change does NOT assert, and why

Replay of an `approval.response` is dead, and R6 records the reason: delete
before resolve, with the map as the single source of liveness. **Nothing
asserts it, and this change does not add the assertion.**

The honest reason is that it is not reachable from an ordinary client. Sealed
frames carry a strict monotonic nonce, so duplicating one on the wire is
refused at the channel layer before any handler sees it — the property is
only exercisable by a *peer that seals a fresh frame with a duplicate id*,
which needs a purpose-built hostile client rather than a tap. Writing a check
that exercises the channel's replay guard and calling it a test of the handler
would be exactly the vacuity the house rules forbid: it would pass whether or
not the handler property held.

So: recorded as a known gap with its cost, not silently skipped. The refactor
this guards against — resolving before deleting, or keeping answered ids for
idempotency — remains catchable only by review until that client exists.

## Consequences

Approval frames are **sealed content**, not lifecycle — so unlike ADR-022's
`revoke`/`revoked`, this needs no relay deploy. The relay cannot see an inner
approval frame at all.

Everything that builds an `ApprovalRequest` or reads an `ApprovalPrompt`
changes: the daemon's approval path, `session.ts`'s two producers, the
extension's decider and consent window, the site's panel, and the e2e and
`acp:check` fixtures. That breadth is the cost of the field being meaningful
at every layer, which is what R4 is about.

## Falsifiability

- **R1:** if a real surface needs a domain that is genuinely open-ended, the
  closed set is wrong — but the burden is on that surface, and
  `prior-art-synthesis.md` records that every open-vocabulary capability
  system in this lineage failed to get adopted.
- **R2:** if a runtime ever has information about its own request that the
  daemon cannot derive, the stamp becomes a claim the daemon *clamps* rather
  than a value it originates — the shape ADR-021 already uses for
  MCP/ACP/WebMCP annotations.
- **R6:** if a concrete replay or TOCTOU path is found, this stops being
  defence in depth and becomes the urgent half; the design does not change,
  only the priority.
