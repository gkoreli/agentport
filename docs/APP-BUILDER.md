# Integrate AgentPort into a web app

AgentPort lets a visitor attach their own running agent to your page. Your app
lends that agent a bounded set of JavaScript functions for one session. Your
app does not choose a model, hold an inference key, pay for inference, or learn
the agent's model or provider.

The public integration is the browser drop-in in `site/src/connect.ts#AgentPort`.
An app does not install the daemon CLI or import the repository's workspace
packages.

## Before you integrate

The visitor runs and pairs their agent separately:

```bash
npx @gkoreli/agentport
```

Your app only loads `connect.js`, describes the capabilities it is willing to
lend, and renders the returned session.

The browser bundle, wallet, relay, and daemon speak one lockstep wire version.
If connection fails with `relay speaks agentport/N`, the hosted deployment and
the installed CLI do not match. That is an AgentPort release problem, not an
error in the embedding app. See [Release and deployment](RELEASING.md).

## 1. Load the drop-in

Use explicit hosted endpoints on a third-party site:

```html
<script
  src="https://agentport.gogakoreli.workers.dev/connect.js"
  data-relay="wss://agentport.gogakoreli.workers.dev/relay"
  data-wallet="https://agentport-wallet.gogakoreli.workers.dev"
></script>
```

The script exposes `window.AgentPort`. Do not call `navigator.agent` directly:
that property exists only when a compatible wallet extension has installed a
provider. `AgentPort.connect()` discovers the extension and provides the
hosted-wallet and connect-code fallbacks.

The script attributes are:

| Attribute     | Meaning                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------ |
| `src`         | The classic browser bundle. It must be allowed by `script-src`.                            |
| `data-relay`  | WebSocket relay URL. External apps should set it explicitly and allow it in `connect-src`. |
| `data-wallet` | Hosted-wallet origin. It must be HTTPS except on localhost.                                |

If `data-relay` is absent, the drop-in uses `ws(s)://<embedding-host>/relay`.
That default is for an app serving its own AgentPort Worker or reverse proxy;
it does not point a third-party app at the public relay.

## 2. Define the tools your page owns

A tool has a name, a human-readable description, a JSON input schema, and a
handler. The handler runs in your page only when the attached agent calls that
granted tool.

```js
const editor = document.querySelector("#editor");

const tools = [
  {
    name: "myapp.document.read",
    description: "Read the current document",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: () => ({ text: editor.value }),
  },
  {
    name: "myapp.document.replace",
    description: "Replace the current document with new text",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The complete replacement text" },
      },
      required: ["text"],
    },
    requiresApproval: true,
    handler: ({ text }) => {
      // Tool arguments are agent-controlled input. Validate them again at the
      // application boundary before using them.
      if (typeof text !== "string") throw new Error("text is required");
      editor.value = text;
      return { ok: true, characters: text.length };
    },
  },
];
```

Tool rules:

- Names may contain letters, digits, `.`, `_`, and `-`, up to 128 characters.
- Names must be unique within the grant.
- Descriptions are consent text. Describe the effect plainly; do not put page
  content or other untrusted text in them.
- `inputSchema` must be a JSON-serializable object.
- Arguments are untrusted even when the schema is correct. Re-check types,
  record ownership, resource state, and application authorization in the
  handler.
- Return `undefined` or a JSON-serializable value. Throw an `Error` for a tool
  failure the agent should see.
- Mark a tool `requiresApproval: true` when every call needs a decision. The
  request's `alwaysAsk` list can impose the same rule centrally; every name in
  `alwaysAsk` must also appear in `tools`.

The runtime contract is `packages/client/src/session.ts#SiteTool`. The grant is
validated before the connection crosses the network by
`packages/client/src/wallet.ts#buildGrant`.

## 3. Connect from a user gesture

Call `connect()` from a button click. The synchronous click is what permits the
wallet popup; calling it during page initialization commonly causes browsers
to block the popup and forces the connect-code fallback.

```html
<button id="connect-agent">Connect your agent</button>
<p id="agent-status"></p>
```

```js
const status = document.querySelector("#agent-status");

const request = {
  name: "My App",
  route: location.pathname,
  context: { documentId: "doc_123" },
  tools,
  ttlMs: 60 * 60 * 1000,
  decide: ({ summary, call }) => {
    const detail = call
      ? `\n\n${call.name}\n${JSON.stringify(call.arguments, null, 2)}`
      : "";
    return Promise.resolve(window.confirm(`${summary}${detail}`));
  },
};

let session;

document.querySelector("#connect-agent").addEventListener("click", async () => {
  try {
    session = await AgentPort.connect(request);
    const scope = session.info.ownTools
      ? "This agent may also request use of its own tools."
      : "On this site the agent can use only the site's tools.";
    const verification = session.info.verify
      ? ` Verify: ${session.info.verify}.`
      : "";
    status.textContent = `Connected to ${session.info.agentName}. ${scope}${verification}`;
  } catch (error) {
    status.textContent = `Could not connect: ${error instanceof Error ? error.message : String(error)}`;
  }
});
```

Render both `session.info.ownTools` and `session.info.verify` when present.
`ownTools` tells the visitor whether their agent retains access to its own
machine capabilities on this attachment. The verification words should match
the words on the daemon or trusted consent surface and detect an intermediary
in the sealing handshake.

The current handle also contains `session.info.runtime`. Do not branch product
behavior on it, display it, or send it to analytics. Exposing the runtime to
the page conflicts with AgentPort's privacy goal and is a known protocol gap;
app code should not make that field harder to remove.

`AgentConnectRequest` is defined at
`packages/client/src/provider.ts#AgentConnectRequest`:

| Field       | Required | Meaning                                                                         |
| ----------- | -------: | ------------------------------------------------------------------------------- |
| `name`      |      yes | Short surface name shown during consent.                                        |
| `tools`     |      yes | Explicit page tools. Use `[]` when relying only on harvested WebMCP tools.      |
| `route`     |       no | Resource or route to which this attachment applies.                             |
| `context`   |       no | Bounded JSON context delivered when the session opens. Do not put secrets here. |
| `alwaysAsk` |       no | Granted tool names that require approval on every call.                         |
| `ttlMs`     |       no | Grant lifetime. The default is one hour.                                        |
| `decide`    |       no | Page UI for decisions about page-owned tools. Missing decision UI fails closed. |

The page may decide whether its own function runs; it may never approve the
agent's shell, files, or other user-machine capabilities. AgentPort routes or
refuses those decisions at a trusted wallet/daemon surface.

## 4. Prompt and render the session

For a simple request, `prompt()` resolves to the complete assistant text:

```js
const answer = await session.prompt("Summarize this document.");
output.textContent = answer;
```

For streaming and cancellation, register listeners before starting the turn:

```js
session.on("delta", ({ promptId, text }) =>
  appendAssistantText(promptId, text),
);
session.on("thought", ({ promptId, text }) => renderReasoning(promptId, text));
session.on("plan", ({ promptId, steps }) => renderPlan(promptId, steps));
session.on("tool", ({ name, arguments: args, ok, result, error }) => {
  renderToolCall({ name, args, ok, result, error });
});
session.on("done", ({ promptId, stopReason, error }) =>
  finishTurn(promptId, stopReason, error),
);
session.on("reattached", ({ verify }) => renderNewVerificationWords(verify));
session.on("closed", ({ reason }) => renderDisconnected(reason));

const turn = session.startPrompt("Rewrite the selected paragraph.");
stopButton.onclick = () => session.cancel(turn.id);

try {
  const completeText = await turn.result;
  renderCompleteAnswer(completeText);
} catch (error) {
  renderTurnError(error);
}
```

The complete handle is `packages/client/src/session.ts#AgentSessionHandle`.
Its operations are:

| Operation                     | Purpose                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| `prompt(text, context?)`      | Send one turn and await its complete assistant text.                                                   |
| `startPrompt(text, context?)` | Start a turn and immediately receive its cancellation ID and result promise.                           |
| `cancel(promptId)`            | Request cancellation of one active turn.                                                               |
| `history()`                   | Fetch the transcript from the user's agent; the page does not own durable history.                     |
| `answer(askId, values?)`      | Answer a question only when an `ask` event was delivered to this trusted surface; omit values to skip. |
| `close(reason?)`              | End the attachment and withdraw its tools.                                                             |
| `on(event, listener)`         | Subscribe; call the returned function to unsubscribe.                                                  |

All callbacks and promises need visible error handling. A tool error should be
shown in the app as well as returned to the agent; a closed or failed session
must not leave the UI looking connected.

## 5. Resume after a refresh

The drop-in remembers a resumable attachment in per-tab `sessionStorage`. Use
the same surface name and tool handlers when attempting to resume:

```js
const resumed = await AgentPort.resume(request);

if (resumed) {
  session = resumed.session;
  attachSessionListeners(session);
} else {
  showConnectButton();
}
```

The stored record contains only the bounded attachment identity and its
session-scoped resume data, never the wallet's root user key. Protocol v6
requires both that original Ed25519 identity and a fresh EPK proof on resume;
the visible token alone is insufficient.

An in-flight prompt can be lost during a socket break even when the session
reattaches. Treat its rejected promise as final and call `history()` if the
visitor needs the agent's durable record of what happened.

## 6. Use existing WebMCP tools

`connect.js` observes `document.modelContext` and snapshots its registered
tools when the attachment opens. Explicit tools passed to `connect()` win name
collisions. A WebMCP-only integration still passes `tools: []`:

```js
document.modelContext.registerTool({
  name: "myapp.selection.read",
  description: "Read the currently selected text",
  inputSchema: { type: "object", properties: {} },
  execute: () => ({ text: window.getSelection()?.toString() ?? "" }),
});

const session = await AgentPort.connect({
  name: "My App",
  tools: [],
  decide: ({ summary }) => Promise.resolve(window.confirm(summary)),
});
```

Load `connect.js` before registering tools so it can observe registrations in
implementations that do not expose an enumerable tool list. Harvested WebMCP
tools always require per-call approval; page-authored annotation hints never
grant authority. The adapter is `packages/client/src/webmcp.ts#toSiteTool`.

## Content Security Policy

At minimum, a restrictive production CSP needs to allow:

```http
Content-Security-Policy:
  script-src 'self' https://agentport.gogakoreli.workers.dev;
  connect-src 'self' wss://agentport.gogakoreli.workers.dev;
```

The hosted wallet opens as a separate top-level popup, not an iframe. If your
policy uses `navigate-to`, `sandbox`, or application-specific popup controls,
also permit navigation to `https://agentport-wallet.gogakoreli.workers.dev`.

## Error handling and diagnosis

| Symptom                               | Meaning                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Popup is blocked                      | `connect()` was not called from a user gesture, or browser policy blocked it. AgentPort falls back to a connect code when possible. |
| `relay speaks agentport/N`            | The daemon and deployed relay use different wire versions. Deploy matching endpoints; changing app code cannot repair it.           |
| `every name in alwaysAsk...`          | An `alwaysAsk` entry is absent from `tools`.                                                                                        |
| `could not reach the relay`           | Check `data-relay`, CSP `connect-src`, TLS, and relay availability.                                                                 |
| Tool call is declined                 | The tool required approval and no decision surface granted it. Missing approval UI fails closed.                                    |
| Session reconnects but a turn rejects | The attachment rekeyed, but the in-flight streamed answer could not be recovered. Fetch `history()`.                                |

Browser logs are available with:

```js
localStorage["agentport.log"] = "debug";
window.__agentport?.logs();
```

Do not log prompt text, tool arguments, tool results, delegation material, or
resume tokens in production telemetry.

## Self-hosted endpoints

An app may serve `connect.js` itself and proxy `/relay` to a self-hosted relay.
In that configuration, omitting `data-relay` deliberately selects the app's
same-origin `/relay`. An HTTPS app must expose the relay over WSS.

All peers must come from the same release. Protocol v6 is a hard coordinated
cutover of relay and endpoints; do not stage a relay-first rollout or retain a
v5 fallback.
