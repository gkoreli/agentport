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
| `src/sw.ts` | service worker | the user key, the relay socket, sessions, grants, consent routing |
| `src/content.ts` | isolated world | the mediator: validation, ownership tables, tool routing, closed iframe host |
| `src/overlay.ts` | extension-origin iframe | the Job 2 widget (status + shared chat), reached only by a MessageChannel |
| `src/pagetools.ts` | isolated world | the generic `page.*` fallback toolset |
| `src/inpage.ts` | page world | `navigator.agent`, WebMCP harvesting. No authority |
| `src/popup.ts` | extension origin | identity, relay, pairing, what is attached |
| `src/consent.ts` | extension origin | the consent/approval window (`chrome.windows.create`) |
| `src/bridge.ts` | shared | the message vocabulary and every validator |

## The trust boundary

```
 [PAGE]  navigator.agent          ← site code can rewrite this
    |    window.postMessage       ← HOSTILE. everything re-validated on arrival
 [CONTENT SCRIPT]  isolated world ← ownership tables, generic tools, iframe bridge
    |    MessageChannel             ← semantic widget commands/actions only
 [EXTENSION IFRAME] extension origin ← shared Chat + ordinary custom-element registry
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
6. **Consent and approval render in extension chrome, never in-page**
   (ADR-009). A connection request opens a popup **window** on the extension
   origin (`chrome.windows.create`) showing the origin as Chrome reported it
   (`port.sender`, labelled verified), the agent picker with online/offline,
   and the requested tools with gated ones marked. Every per-call approval
   opens the same extension-origin window with full arguments. OS notifications
   are deliberately not used because a platform may suppress one after Chrome
   reports successful creation, leaving the request unanswered. A site can
   cover any in-page overlay and imitate any in-page dialog; it cannot draw,
   read, or click a browser window it does not own. The in-page widget shows
   status only — it never renders an approve control. Escape and a closed
   window both mean deny; a missing answer is a denial, never a default grant.
7. **What a page learns cannot correlate across origins** (ADR-009). The
   session info handed to a page reports `agentName: "Personal agent"` and a
   generic runtime — never the real agent name, pubkeys, or cert contents,
   which render only in extension chrome. For the site's own UX continuity the
   info carries an `alias` derived as `hash(per-install random seed + origin)`:
   stable for that origin across visits, meaningless to any other origin.

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
  `document.modelContext` when it exists, falls back to the deprecated
  `navigator.modelContext`, and installs a minimal two-spelling shim when
  neither exists, so a site that registers tools gets AgentPort for free.
  Harvested tools execute in the page (that is where they were defined). They
  are ungated by default because the site deliberately published them;
  `annotations.destructiveHint: true` opts a tool into per-call approval.
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

The popup and `overlay.html` use `component()` in an extension-origin registry.
The content script creates only a plain extension-origin iframe inside a closed
shadow root; it never registers or constructs the shared Chat's custom
elements. A MessageChannel carries semantic commands into the iframe and user
actions back out. The host page cannot traverse that closed root to obtain the
iframe or its `contentWindow`. Consent and approval controls stay in extension
chrome; injected consent UI elsewhere in AgentPort remains template-only.

## One-tap connect and refresh-resume

`navigator.agent` matches the drop-in provider's surface: `isAvailable()`,
`connect(request)`, `resume(request)`. Site tool handlers run in the page; a
`tool.call` round-trips sw → content → inpage → page handler and back, checked
against the grant at every hop.

A page refresh (or navigation within the origin) resumes without any new
consent, in two layers:

1. **Worker-held re-binding.** The service worker owns the relay socket and
   the session; a navigating document only orphans its binding. The next
   document from the same origin + surface reclaims it (2-minute grace) —
   nothing crosses the network.
2. **Relay-token resume.** If the worker itself was evicted and restarted, a
   resume record `{sessionId, agent, token}` in `chrome.storage.session`
   (extension contexts only, dies with the browser) lets it re-attach via
   `wallet.resumeSession`. Every resumed attachment performs a mandatory fresh
   sealing handshake; plaintext resume is not a protocol state.

The socket itself is kept alive by a 20s storage touch while sessions exist
plus a `chrome.alarms` wake, and a dropped socket is redialed with backoff
(daemon-style); worker-held sessions are re-attached in place, so the page
keeps its ref and never notices.

## What is stubbed

- **No key protection at rest.** `ensureUserKey` writes a raw hex key. Passkey
  wrapping, or delegating signing to a NIP-46 bunker, changes `src/storage.ts`
  and nothing else.
- **No revocation UI.** The popup lists agents and live sessions; it cannot
  unpair one. Revocation is edge-side since ADR-016 made the relay stateless:
  it belongs to the daemon's identity file and the wallet's own store, not to
  the relay.
- **MV3 idle eviction.** A 20s heartbeat plus a 1-minute `chrome.alarms` wake
  keep the worker and socket alive while sessions exist. Chrome 116+ also
  counts WebSocket traffic as activity. A long silent session can still be
  evicted; the alarm redials and the resume records re-attach on the next
  wake, so the session survives the gap rather than the socket.
- **`isAvailable()` answers from local state**, not from the relay: dialing the
  relay to answer a page's probe would let any site force a socket and learn
  that the user has agents before consenting to anything.
- **Prompt ids are wallet-side.** A page learns a prompt's id from the first
  `delta`/`done` event, so `cancel()` before the first token is not expressible.
- **Boundary coverage is split by environment.** `check.ts` exercises hostile
  page-message validation and bundle separation. `scripts/extension-ui-smoke.ts`
  loads the unpacked extension into real Chrome against a page that predefines
  the chat tags and patches `attachShadow`; it verifies the opaque iframe host
  and the shared `UI-CHAT` tree. Forged session/tool-result cases still belong
  in the socket-level adversarial suite.

## Typecheck

```bash
npx tsc -p packages/extension/tsconfig.json
npm run check:extension
AGENTPORT_CHROME=/path/to/chrome-for-testing npm run ui:extension-smoke
```
