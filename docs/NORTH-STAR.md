# North star

The one thing this project is for, and how everything else relates to it.

Read this before proposing architecture. AGENTS.md tells you how the code
works; this tells you what it is trying to become and, just as importantly,
what it is not.

## The claim

**A person should own one agent and carry it everywhere.**

Not one agent per website. Not a chatbot in the corner of every app, each
paying for its own inference, each starting from zero about who you are. One
agent — running where you put it, on your subscription, with your memory, your
prompts, your MCP servers, your judgment about what it may do — that any
website can borrow for the length of a visit.

The website supplies the *capability*: here is what can be done on this page.
The user supplies the *agent*: here is who does it. Those are different
things, owned by different people, and nothing before this treated them that
way.

## What "the site learns nothing" means

It is the whole product, so it is worth being exact. Across a session the site
never learns:

- **which runtime** — Claude Code, goose, codex, something you wrote yourself;
- **which model** — or which provider, or which version;
- **whose memory** — the agent's history, prior sessions, your other work;
- **who pays** — there is no inference bill for the site, and no API key;
- **what else the agent can reach** — your files, your other tools, your other
  attachments.

What the site does learn is what it needs to route a session: that an agent is
attached, and what it did with the tools the site itself lent it.

Every proposed feature gets measured against that list. A feature that leaks an
item off it has to justify itself very well, and probably cannot.

## Why this is a primitive and not a product feature

`window.nostr` (NIP-07) is the shape to have in mind. Before it, every site
that wanted a signature either held your key or asked you to paste one. NIP-07
made "the user holds the key, the site asks" a browser-level fact, and the
question stopped being interesting.

`navigator.agent` is the same move for agency: *here are my tools, run them on
my behalf.* The site stops needing to own an agent, and the user stops needing
a new one per site.

Primitives are judged by what they make ordinary. If this works, "bring your
own agent" stops being a feature anyone ships and becomes a thing browsers do.

## How the neighbours relate

None of these is a competitor. Each solves a real problem next to ours, and
where one is good we use it rather than restate it. Getting this hierarchy
right matters, because treating a component as a rival produces bad
architecture — and treating a rival as a component produces worse.

**AG-UI** normalizes the agent-to-client edge: event types, streaming, run
semantics. It exists so an application builder can add agentic flows to their
own site with their own agent, and it does that well. It assumes the builder
controls the agent — the assumption AgentPort removes. So AG-UI is a component
we use internally, not a layer we negotiate with. Everything this project is
about is simply outside its scope, and always was.

**WebMCP** (`document.modelContext`) is a site declaring what it can do, for
whatever agent is present. That is exactly the input side we want, so a site
that already speaks WebMCP should get AgentPort with no extra work. We harvest
those registrations into a session grant rather than inventing a second
tool-description format.

**MCP** is how tools reach a model, and **ACP** is how a client drives an agent
process. The daemon is an ACP client, which is why the runtime is pluggable and
why the site's lent tools can appear to the agent as an ordinary MCP server.

**NIP-46 / passkeys / WebAuthn** are where key custody is going. The user key
is deliberately isolated so that swapping raw Ed25519 for a bunker or a passkey
touches one file.

The gap none of them fills — and the only one we are trying to fill — is
granting a **user-chosen remote agent** a **site-defined toolset**, with
consent that happens where the user's key is and content that nobody in the
middle can read.

## The widest form of the claim: every website, not just the ones that opted in

The integration story above assumes a site chose to participate — it declared
tools, or it registered them with WebMCP. That is the clean case, and it is
where the primitive eventually lands.

But most of the web will never declare anything. And a browser extension can
supply the missing half: it can read and drive the page the user is already
looking at, and lend *that* to the user's agent as a capability grant. The site
did not opt in and does not need to.

This is the same product, taken to its widest form:

- **On a site that declared tools**, the agent gets the site's own intent —
  named actions that carry meaning, with the site's own approval hints.
- **On a site that declared nothing**, the agent gets the generic page harness
  — read the page, list what is on it, fill, click, scroll — supplied by the
  extension. It cannot yet search the page or navigate it; ADR-021 proposes
  `page.navigate` and does not build it, which is why the harness still ends
  at the edge of one document.
- **On a site that declared some things**, it gets both, with the site's own
  tools preferred where they overlap, because a named action beats synthesized
  clicks every time.

The user should not have to know which case they are in.

The part that makes this different from a browser vendor shipping an assistant:
**it is the same agent.** Not a different assistant that lives in the browser
and knows nothing about you — the one already running on your machine, with
your memory, your prompts, your MCP servers, your files, the context of
everything else you have been doing with it. A browser-vendor assistant is
another agent to bring things to. This one is the agent you already brought
everything to, now able to see and act on the page in front of you.

What that demands, and where we currently fall short:

- **A session must outlive a navigation.** Driving a real website means
  clicking something and going somewhere. An agent whose session dies the
  moment it succeeds at clicking a link is not an automation harness; it is a
  demo. The attachment belongs to the *user and the origin*, not to the
  document instance.
- **Consent must be remembered.** "Attached, then detached" is about the
  agent's authority ending, not about making the user re-approve the same
  agent for the same site every few minutes. Approving once should mean
  something durable and revocable, and per-call approval should be reserved
  for what actually deserves it.
- **The harness must be good enough to trust.** Generic page tools are what
  the agent falls back to when a site says nothing, so their failure modes are
  the product's failure modes.

None of this weakens what the site learns: the site is not a party to any of
it. On an undeclared site, the site does not even know an agent is present.

## What we will never be

These are load-bearing. A change that violates one is wrong even if it is
locally attractive.

- **Not an inference router.** We never see a model, a key, or a token count.
  The moment we do, the user is our product and the thesis is dead.
- **Not an agent framework.** Runtimes are pluggable and we do not own the
  loop. If a better agent appears next year, our users should get it by
  changing an environment variable.
- **Not a workspace.** The agent is attached and then detached. It is not a
  member of anything, it does not live here, and there is no account to churn.
- **Not a new tool-description format.** Long term the site's tools come from
  WebMCP. `SiteTool` is shaped to match, and should keep converging.

## What has to be true for this to work

In rough order of how load-bearing they are:

1. **Nobody in the middle can read the conversation.** Content is sealed
   end-to-end; the relay carries ciphertext. If this is ever compromised the
   product has no argument left.
2. **Consent happens where the key is** — the user's own wallet or daemon,
   never the page asking for the capability. A site must never be able to
   answer its own approval prompt.
3. **The grant is a real boundary.** A tool not in the grant cannot be called;
   an expired grant cannot be used. Enforced at both edges, not asserted.
4. **Ownership is provable and revocable.** A user key signs "this is my
   agent"; the relay can verify but never forge; the user can take it back.
5. **The user's data stays on the user's machine.** The transcript belongs to
   the agent that produced it. We do not become the place your conversations
   live.
6. **Integration is one call.** If a site needs to understand our protocol to
   adopt us, we have failed at the only thing that drives adoption.

### Why the sixth one is the one that breaks

Five of those are about what happens *after* a site adopts. The sixth is about
whether it ever does — and it is the only one that binds at the edge of the
system, where nobody working on the system ever stands.

This is not hypothetical. For a long stretch of this repo's history the
README's first code block — the thing GitHub renders above everything else —
called `navigator.agent.connect(...)`. `connect.js` only ever *reads* that
property, and in a stranger's browser nothing has installed it. So the documented integration
threw a bare `TypeError` for every visitor without our extension, which is
precisely the population the whole fallback ladder exists to serve. Five
requirements had adversarial e2e checks; this one had a broken first line.

The reason it survived is worth more than the bug: **a requirement about
people who have not arrived yet cannot be verified by people who are already
here.** Everyone working on this has a wallet, an extension, a daemon and a
checkout. Nobody is ever in the state where that snippet is the first thing
they read, so nobody was ever in a position to notice.

And it does not have a check. You cannot assert your way to a good front door
— an assertion encodes what we already believe the path is, which is the same
blind spot in executable form. What it has instead is an obligation:
**periodically arrive as a stranger.** Walk the path in order, from the
outside, with nothing installed — README, script tag, first call, first
failure — and fix whatever a stranger would hit. That is a thing a person
does, not a thing a suite proves, and it is the only one of the six that
works that way.

## How we would know it worked

Not metrics — signals, roughly in the order we would expect to see them:

- A site adopts it without talking to us, because the integration was obvious.
- A site that only implemented WebMCP discovers it works with AgentPort for
  free.
- Someone runs a relay we do not operate, and it just works.
- Someone swaps in a runtime we have never heard of, and that just works too.
- A user attaches the same agent to two unrelated sites in one afternoon and
  finds it unremarkable.
- Someone argues that this should be in the browser, not in an extension.

The last one is the actual target. The end state for a primitive is that it
stops needing a project.
