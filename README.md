# AgentPort

**Bring your own agent to any website.**

```js
const session = await navigator.agent.connect({
  name: 'Inkwell',
  tools: [
    {
      name: 'inkwell.document.read',
      description: 'Read the current document',
      inputSchema: { type: 'object', properties: {} },
      handler: () => ({ text: editor.value }),
    },
  ],
  alwaysAsk: ['inkwell.document.replaceSelection'],
});

await session.prompt('Tighten the opening paragraph.');
```

That is the entire integration a website writes. No API key, no model choice,
no inference bill. The user picks one of *their own* agents — running on their
VPS, on their subscription, with their memory, prompts, and MCP servers — and
the site lends it a few tools for the length of the session.

Today every app ships an isolated chatbot and pays for its own inference.
AgentPort inverts that: **the user owns one agent and carries it between
applications.**

## How it fits with what already exists

| layer | what we use | what we add |
|---|---|---|
| tool surface | WebMCP (`navigator.modelContext`) | grants scoped to *one session with one agent* |
| conversation | ACP / AG-UI shaped events | — |
| identity | Ed25519 certs today, NIP-46 / passkeys next | user→agent ownership binding |
| transport | WebSocket relay | pairing, presence, per-site revocation |

The gap AgentPort fills is narrow and real: NIP-46 grants *signing* scopes,
WebMCP hands tools to *the browser's* agent. Nobody grants a **user-chosen
remote agent** a **site-defined toolset**. That's this.

## Try it

```bash
npm install

npm run relay     # terminal 1 — ws://127.0.0.1:8787
npm run daemon    # terminal 2 — prints a pairing link + code
npm run demo      # terminal 3 — http://127.0.0.1:8788
```

Open the demo, click **Pair a new agent**, paste the code from terminal 2, then
**Connect agent**. You'll get the picker, the consent screen, and a working
writing panel whose brain is the process in terminal 2.

No browser needed to verify the protocol:

```bash
npm run e2e
```

## Status

Early but real. Pairing, ownership certs, directory, presence, capability
grants, streaming, tool calls, approvals, and teardown all work and are
covered by `scripts/e2e.ts`.

The daemon currently ships demo runtimes rather than a real one — wiring
Claude Code in behind the `AgentRuntime` interface is the next commit. See
[AGENTS.md](./AGENTS.md) for architecture, security invariants, and the
roadmap.

Apache-2.0.
