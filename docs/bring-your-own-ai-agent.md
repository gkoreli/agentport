# Bring Your Own AI Agent

Every new app seems to come with the same offer: pay another $20 a month for its AI feature.

A writing app wants one subscription. A task app wants another. A research tool wants a third. Each gives you a new chatbot with no memory of the work you did elsewhere. Each asks you to trust a new company with your prompts and data. Cancel the app and the agent goes with it.

Enough.

I want one AI subscription. I want one agent that knows how I work, runs where I choose, and comes with me to every website.

**Bring your own agent to any website.**

## The user should own the agent

Most AI products bind the agent to the app. The app chooses the model, pays for inference, stores the chat, and charges the user for access. This repeats the same stack on every website.

The split should be much simpler:

- The website supplies the actions: read this document, update this task, search this catalog.
- The user supplies the agent: their model, subscription, memory, prompts, and tools.

The site lends a small set of actions for one session. The user's agent does the work, then disconnects.

This is what AgentPort does.

## WebMCP gives the website a voice

The web already has a draft answer for how a site can describe its actions. It is called WebMCP.

WebMCP lets a page say, in a form an agent can use: “Here are the tools available here.” A writing app can publish `readDocument` and `replaceSelection`. A shop can publish `searchProducts` and `addToCart`. The tool runs inside the page, where the product already knows how its own data and controls work.

That is the right input to AgentPort. AgentPort does not ask developers to rewrite WebMCP in a private format. It collects the tools a page registers through `document.modelContext` and lends them to the user's agent for the session.

WebMCP and AgentPort solve different parts of the problem:

- WebMCP says what the website can do.
- AgentPort says which user-owned agent may do it, with whose consent, for how long, and over which private connection.

WebMCP does not choose the user's agent. It does not prove that the agent belongs to the user, connect to an agent on a laptop or VPS, or set the bounds of a session. AgentPort adds that missing trust and transport layer.

The full path is simple: **WebMCP tools in, the user's agent in the middle, and streamed results back to the app.**

## One script connects the two

An app developer starts with one script:

```html
<script
  src="https://agentport.gogakoreli.workers.dev/connect.js"
  data-relay="wss://agentport.gogakoreli.workers.dev/relay"
></script>
```

`data-relay` is not decoration: without it the script dials `/relay` on the
site's own host, which is right only for someone running their own relay. The
canonical, executed copy of this snippet is the one in `README.md` — it is
extracted and run by `npm run snippet:check`, and this article's shorter form
is prose about it, not a second front door.

The page can then register an ordinary WebMCP tool:

```js
await document.modelContext.registerTool({
  name: 'inkwell.document.read',
  description: 'Read the current document',
  inputSchema: { type: 'object', properties: {} },
  execute: () => ({ text: editor.value }),
});

// Connecting opens the user's wallet, so it needs a user gesture behind it.
document.querySelector('#connect-agent').addEventListener('click', async () => {
  const session = await AgentPort.connect({ name: 'Inkwell', tools: [] });
  await session.prompt('Tighten the opening paragraph.');
});
```

AgentPort collects that registration when the user connects. A site can also pass tools straight to `AgentPort.connect`, but WebMCP is the path that lets the same site tools work with more than one agent system.

The site does not need an AI provider, an API key, a model picker, or an inference bill. It publishes what its product can do and lets the user choose the agent.

The script alone cannot know what “send invoice” or “publish article” means inside every product. The app must expose those actions. This is a good limit: the app defines what can happen, while the user decides who does it.

WebMCP remains an experimental draft, so the current claim must stay narrow. AgentPort supports imperative tools registered after its script loads, including the older `navigator.modelContext` form. It does not claim full WebMCP support. Today, every tool collected from a page asks for user approval on each call because the page cannot grant authority to itself.

## A wallet for AI agents

MetaMask gave websites a standard way to ask for a user's wallet without taking custody of the user's keys. AgentPort uses the same shape for agents.

A site asks to connect. The user picks one of their agents and approves the actions the site wants to lend it. The agent may run on the user's laptop, a home server, or a VPS. The site does not need to know which runtime or model sits behind it.

The user keeps control of:

- the agent and where it runs;
- the model and the bill;
- its memory, prompts, files, and private tools;
- which site actions it may use, and for how long.

The website learns only what it needs for the session: that an agent connected and what happened through the actions the site supplied. It does not receive the user's model key, private memory, other tools, or past chats.

## Private by design

The agent can run anywhere because the session content is encrypted from end to end. AgentPort's relay pairs the browser with the agent and passes sealed messages between them. It carries ciphertext; it cannot read the conversation.

The relay also stores no session history. Durable identity stays at the edges, with the user's wallet and agent. Secret keys never cross the wire.

This needs one precise caveat. End-to-end encryption protects the connection from the relay and other middlemen. It does not make an app blind to data that the user or agent chooses to send through that app's own actions. If an agent replaces text in an editor, the editor can see the new text. Privacy comes from a narrow grant, clear consent, encryption in transit, and keeping the agent's wider context out of the site.

Prompts and transcripts belong with the agent, under the user's control. AgentPort is not an inference router and does not become another company that collects the user's chats.

If you do not want to trust the hosted relay even with ciphertext, you can run your own.

## Stop rebuilding the same chatbot

Today, app teams keep building chat panels, model menus, prompt stores, rate limits, billing systems, and tool loops. Then they charge users to fund the same parts every other app also built.

With a user-owned agent, an app can focus on its real value. A writing app should build a fine editor. A task app should build a fine way to plan work. Both can expose useful actions to the same agent.

The user gets continuity. The agent that helped research an idea can edit the draft and create the follow-up tasks without becoming three separate bots. Its memory and working style do not reset at each domain.

The developer gets a smaller product. There is no model contract to pick, no inference cost to hide inside a paid tier, and no need to hold the user's AI credentials.

## It should work on every website

Sites that publish WebMCP tools give AgentPort clear, named actions with tight grants. That gives the agent the safest and most useful view of the product. A site can add the AgentPort script to offer its users a direct connection, while the extension can collect the same WebMCP tools on sites that did not add AgentPort itself.

Sites that do not add it can still work through a browser extension that lends common page actions such as reading, filling, clicking, and scrolling. Native actions remain better because they carry the site's intent, but users should not have to wait for every site to opt in.

In both cases, the important part stays the same: it is the user's agent. A browser vendor does not replace it with another assistant. A website does not rent the user a fresh bot. The agent they already chose gains limited access to the page in front of them.

## One subscription. One agent. Any app.

Software subscriptions will not vanish, nor should they. People should pay for products that help them. But access to an AI model should not become a separate $20 toll inside every product.

Let users pay once for the agent they want. Let them run it where they want. Let each website lend it only the actions needed for the task.

For developers, the front door starts here:

```html
<script
  src="https://agentport.gogakoreli.workers.dev/connect.js"
  data-relay="wss://agentport.gogakoreli.workers.dev/relay"
></script>
```

For users, the promise is even shorter:

**Your agent. Your subscription. Your data. Every website.**

The core path works now: WebMCP tool collection, pairing, ownership checks, scoped grants, streaming, tool calls, approvals, and teardown. Under the hood, ACP lets the daemon drive different agent runtimes, while AG-UI-shaped events carry the output. AgentPort sits between those parts as the trust and transport layer they do not provide.

The long-term goal is bigger than one project. Websites should publish capabilities through WebMCP. Users should bring the agent that uses them. Bringing your own agent should become a normal part of the web.
