# @agentport/extension

The wallet, outside the page.

In the Inkwell demo the wallet lives in the page: `localStorage` holds the user
key and the site's own JavaScript could read it. That is fine for a demo and
unacceptable for anything else. This package moves key custody, the relay
socket, the agent picker, the consent screen and every approval prompt behind an
MV3 extension boundary, and gives the page a `navigator.agent` that is a
postMessage stub with no authority of its own.

It also does the thing no site has asked for yet: it attaches the user's agent
to pages that never heard of `navigator.agent`, either through the site's own
WebMCP tools or through a generic `page.*` toolset.

## Build and load

```bash
npm run build:extension          # → packages/extension/dist
npx tsx packages/extension/build.ts --watch
```

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked** → `packages/extension/dist`.
3. Click the AgentPort toolbar icon → **Create a user key**.
4. Set the relay if it is not `ws://127.0.0.1:8787`.
5. `npm run relay` and `npm run daemon` in two terminals; paste the daemon's
   pairing code into the popup and **Approve & sign**. The cert is signed inside
   the service worker.

Then either:

- open the Inkwell demo (`npm run demo`) — with the extension installed the page
  can drop its in-page wallet and call `navigator.agent.connect()`; or
- open any site at all and use the floating ◆ widget in the corner.

Reload the extension from `chrome://extensions` after each rebuild; content
scripts need a page reload too.

## Layout

| file | context | holds |
|---|---|---|
| `src/sw.ts` | service worker | the user key, the relay socket, sessions, grants |
| `src/content.ts` | isolated world | the mediator: validation, ownership tables, tool routing |
| `src/overlay.ts` | isolated world | picker / consent / approval UI in a closed shadow root |
| `src/pagetools.ts` | isolated world | the generic `page.*` fallback toolset |
| `src/inpage.ts` | page world | `navigator.agent`, WebMCP harvesting. No authority |
| `src/popup.ts` | extension origin | identity, relay, pairing, what is attached |
| `src/bridge.ts` | shared | the message vocabulary and every validator |

## The trust boundary

```
 [PAGE]  navigator.agent          ← site code can rewrite this
    |    window.postMessage       ← HOSTILE. everything re-validated on arrival
 [CONTENT SCRIPT]  isolated world ← UI, ownership tables, generic tools
    |    chrome.runtime.Port
 [SERVICE WORKER]  user key, one WebSocket to the relay
    |    ws
 [RELAY] → [AGENT on the user's VPS]
```

Rules the two boundaries enforce, mirroring the invariants in `AGENTS.md`:

1. **The key never leaves the worker.** `chrome.storage.local` is read only by
   `src/storage.ts`, signing happens only in `sw.ts`, and no message type can
   return key material. The page-world and content bundles do not even contain
   the Ed25519 code — `dist/inpage.js` and `dist/content.js` have no `ed25519`
   symbol in them.
2. **The page may only ask for three things.** Open a session, prompt a session
   it owns, and answer a tool call it was actually handed. Everything else in
   `readPageOutbound` is dropped without a reply.
3. **Identity is stamped, never claimed.** The surface origin sent to the agent
   comes from `port.sender.origin` — Chrome's view of the frame — not from
   anything the page said. This is invariant 3 applied one layer further out
   than the relay.
4. **Session references are ownership-checked on every use.** Refs are minted in
   the worker, recorded against the port that opened them and against `page` or
   `widget`. A page cannot prompt, close, or answer tool calls for the widget's
   session, or for another frame's.
5. **Tool calls only reach whoever declared the tool.** The content script keeps
   a per-session name → route table. A page tool call goes to the page; a
   generic `page.*` call runs in the isolated world; a call for a name that is
   not in the table is refused before it leaves the content script. The grant is
   enforced again in the worker and again on the daemon.
6. **Consent and approval never render in page DOM.** The picker, the capability
   screen and every per-call approval live in a **closed** shadow root created
   by the content script. The site cannot read what is about to be approved and
   cannot forge a decision — a synthetic click in page script does not reach
   into a closed root, and the decision travels over the port, not the DOM.
   Escape means deny; a dropped port resolves outstanding questions as denials.

Things the boundary deliberately does *not* claim to stop:

- **The channel id is not a secret.** It is on the injected `<script>` tag and
  the page can read it. It separates our traffic from other `postMessage`
  traffic; authority comes from the ownership checks, never from the id. A page
  that talks to the content script directly, without our provider, gains exactly
  the same rights the provider had: none.
- **A page can lie to itself.** It can rewrite `navigator.agent`, swallow the
  session, or fake a transcript. That is the site deceiving its own users about
  its own UI, and no wallet can prevent it. What it cannot do is reach the key,
  the relay socket, another session, or a tool it did not declare.
- **The page can obscure the widget.** The overlay's contents are unreachable,
  but a site can draw over the host element. Chrome's own extension chrome (the
  toolbar popup) is the only truly untouchable surface; moving the approval flow
  there is listed under "stubbed" below.
- **`chrome.storage.local` is not a secure element.** It is out of the page's
  reach, which is the point; it is not out of reach of malware with the profile.

## The fallback surface (Job 2)

Every page gets a floating ◆ button in the top frame. Attaching opens the same
consent flow as a site-declared grant, over one of two toolsets:

- **WebMCP, if the site has any.** `src/inpage.ts` wraps
  `navigator.modelContext` when it exists and installs a minimal shim when it
  does not, so a site that registers tools gets AgentPort for free. Harvested
  tools execute in the page (that is where they were defined), and anything the
  site did not explicitly annotate `readOnlyHint` is gated behind approval.
- **Otherwise the generic `page.*` toolset:** `page.info`, `page.readText`,
  `page.readSelection`, `page.listElements`, `page.scroll` are ungated reads;
  `page.fill` and `page.click` mutate the document and always ask. Writes
  address elements by a handle from `page.listElements`, never by a selector, so
  the agent can only act on something that was enumerated to it and the approval
  card can name the element instead of showing a CSS string.

Page text is hostile data. `page.readText` returns it labelled as untrusted, and
the approval round-trip is the only thing between a poisoned paragraph and a
click — see "Prompt injection" in `AGENTS.md`.

## nisli

The UI is built with [`@nisli/core`](https://github.com/gkoreli/nisli) 0.54.1 —
signals, `html` templates, `when`, `each`, `computed`, `effect`.

One deliberate split: the popup uses `component()` (custom elements), the
injected overlay does not. Inside a page, `component()` would register tag names
in a registry whose isolation from the main world is a browser implementation
detail, and a tag the page could pre-empt is a tag the page could implement.
Templates own their DOM outright, so the overlay's trust story does not depend
on that detail. Nothing else about nisli needed working around: it has no
runtime dependencies, needs no compiler, and mounts happily into a shadow root.

Known caveat: nisli builds DOM by assigning to `template.innerHTML`. On a page
that enforces `require-trusted-types-for 'script'`, isolated-world scripts are
exempted by Chrome today, but that exemption is the kind of thing that changes.

## What is stubbed

- **Approvals render in the page's viewport, not in browser chrome.** A closed
  shadow root is the strongest thing a content script has; a site can still draw
  over it. The endgame is `chrome.windows.create` for approvals.
- **No key protection at rest.** `ensureUserKey` writes a raw hex key. Passkey
  wrapping, or delegating signing to a NIP-46 bunker, changes `src/storage.ts`
  and nothing else.
- **No revocation UI.** The popup lists agents and live sessions; it cannot
  unpair one. `CertStore.remove` on the relay still has no caller.
- **Reconnect is lazy and lossy.** A dropped relay socket tears down every live
  session; the next request builds a new wallet. Session resume is the item on
  the roadmap that fixes this properly.
- **MV3 idle eviction.** A 20s heartbeat keeps the worker alive while sessions
  exist. Chrome 116+ also counts WebSocket traffic as activity. A long silent
  session on an older Chrome can still be evicted.
- **`isAvailable()` answers from local state**, not from the relay: dialing the
  relay to answer a page's probe would let any site force a socket and learn
  that the user has agents before consenting to anything.
- **Prompt ids are wallet-side.** A page learns a prompt's id from the first
  `delta`/`done` event, so `cancel()` before the first token is not expressible.
- **No tests.** The overlay and the boundary validators were exercised by hand
  against happy-dom; nothing is wired into `scripts/e2e.ts` yet. The natural
  addition is a headless check that a forged `tool.result` and a forged session
  ref are both refused.

## Typecheck

```bash
npx tsc -p packages/extension/tsconfig.json
```
