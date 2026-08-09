# AgentPort

**Bring your own agent to any website.**

```html
<script
  src="https://agentport.gogakoreli.workers.dev/connect.js"
  data-relay="wss://agentport.gogakoreli.workers.dev/relay"
  data-wallet="https://agentport-wallet.gogakoreli.workers.dev"
></script>

<textarea id="editor">A first draft.</textarea>
<button id="connect-agent">Connect your agent</button>
```

```js
const editor = document.querySelector("#editor");

document.querySelector("#connect-agent").addEventListener("click", async () => {
  const session = await AgentPort.connect({
    name: "Inkwell",
    tools: [
      {
        name: "inkwell.document.read",
        description: "Read the current document",
        inputSchema: { type: "object", properties: {} },
        handler: () => ({ text: editor.value }),
      },
      {
        name: "inkwell.document.replace",
        description: "Replace the current document",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        requiresApproval: true,
        handler: ({ text }) => {
          if (typeof text !== "string") throw new Error("text is required");
          editor.value = text;
          return { ok: true };
        },
      },
    ],
    decide: ({ summary }) => Promise.resolve(window.confirm(summary)),
  });

  await session.prompt("Tighten the opening paragraph.");
});
```

Call `AgentPort.connect()` from a user gesture: the hosted wallet opens on its
own origin, and browsers only permit that popup while the click is live. An
external site must set `data-relay` explicitly; without it, the drop-in uses
the embedding site's own `/relay`, which is the self-hosted configuration.

The complete integration contract — tool rules, approvals, session events,
resume, WebMCP, CSP, errors, and deployment compatibility — is in the
**[app-builder guide](docs/APP-BUILDER.md)**.

`AgentPort.connect` is the call to write, because it works whether or not the
user has anything installed: it prefers an installed wallet, falls back to a
popup on the wallet's own origin, and falls back again to a connect code. The
eventual shape is `navigator.agent.connect(...)` with the same request — that
is what an installed wallet provides today and what we would like a browser to
provide one day. **Do not call `navigator.agent` directly**: it is undefined
for every user who has installed nothing, which is most of them, and that is
the case the fallback ladder exists for. No API key, no model choice,
no inference bill. The user picks one of *their own* agents — running on their
VPS, on their subscription, with their memory, prompts, and MCP servers — and
the site lends it a few tools for the length of the session.

Today every app ships an isolated chatbot and pays for its own inference.
AgentPort inverts that: **the user owns one agent and carries it between
applications.**

## How it fits with what already exists

None of the following is a competitor. Each solves a real problem next to this
one, and where one is good we use it rather than restate it —
[`docs/NORTH-STAR.md`](docs/NORTH-STAR.md) explains why that hierarchy matters.

| layer | what we use | what we add |
|---|---|---|
| tool surface | WebMCP (`document.modelContext`) | grants scoped to *one session with one agent* |
| conversation | ACP / AG-UI shaped events | — |
| identity | Ed25519 certs today, NIP-46 / passkeys next | user→agent ownership binding |
| transport | WebSocket relay | pairing, presence, per-site revocation |

The gap AgentPort fills is narrow and real: NIP-46 grants *signing* scopes,
WebMCP hands tools to *the browser's* agent. Nobody grants a **user-chosen
remote agent** a **site-defined toolset**. That's this.

## Live

**https://agentport.gogakoreli.workers.dev** — one Cloudflare Worker serving both
demo surfaces and the relay they connect to.

> **Deployment status:** `@gkoreli/agentport@0.1.6` and the hosted relay both
> speak `agentport/5`. The production pairing, sealed-session, tool-call, and
> prompt smoke passes. See [Release and deployment](docs/RELEASING.md).

Start your agent and pair it with Chrome:

```bash
npx @gkoreli/agentport
```

Open the one-time link it prints and approve it. Where that approval appears
depends on what you have, and you do not have to know which:

- **nothing installed** — the AgentPort Wallet opens on its own origin, which
  the site cannot read;
- **our extension** — it happens in extension chrome instead. There is no
  store listing yet; it is a load-unpacked build, and
  [`packages/extension`](./packages/extension) says how;
- **popups blocked** — you get a code to paste into the terminal your agent is
  running in, and consent happens there.

Connect on Inkwell, then open Tasker: same agent, entirely different hands.

## Try it locally

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
npm run e2e            # local, mock runtime, 187 checks over real sockets
npm run wire:check     # 521 wire-validation cases across 45 frame types
npm run site:build     # bundle the demo surfaces
npm run deploy         # build + wrangler deploy
npx tsx scripts/remote-check.ts   # pair + prompt against the deployed relay
npx tsx scripts/acp-smoke.ts      # real ACP agent; run where it is authenticated
```

## Run your own relay

The relay is the only third party in the path, and the argument for trusting
it is that you do not have to: session content is sealed end to end, so it
carries ciphertext. If that is not enough for you, do not take our word for
it — run your own.

```bash
AGENTPORT_RELAY_HOST=0.0.0.0 AGENTPORT_RELAY_PORT=8787 npm run relay
```

Then point everything at it:

```bash
AGENTPORT_RELAY=ws://your-host:8787 npx @gkoreli/agentport
```

Verified end to end against a relay bound this way — pairing, an
approval-gated tool call, a prompt and teardown all complete
(`npx tsx scripts/remote-check.ts` with `AGENTPORT_RELAY` pointed at it).

Two honest caveats. A browser on an `https://` page will only dial `wss://`,
so a real deployment needs TLS terminated in front of this process — any
reverse proxy will do; the relay speaks plain WebSocket and expects to sit
behind one. And the relay is stateless by construction, so there is nothing
to back up and no migration to run: it holds sessions in memory for as long
as the sockets live and stores nothing.

The other route is the Cloudflare Worker in `site/` deployed to your own
account, which is how the hosted one runs. That path is not verified here.

## Status

Early but real. Pairing, ownership certs, directory, presence, capability
grants, streaming, tool calls, approvals, and teardown all work and are
covered by `scripts/e2e.ts`.

Verified against a real agent: Claude Code over ACP on a VPS reads and writes
through the site's lent tools, with every gated write approved in the browser.
See [ADR-018](./docs/ADR.md#adr-018-security-architecture-is-explicit-fail-closed-and-enforced-at-the-edges--accepted)
for the security architecture and threat model, and [AGENTS.md](./AGENTS.md)
for the implementation map and roadmap.

Apache-2.0.
