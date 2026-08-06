# WebMCP conformance memo

**Date:** 6 August 2026  
**Scope:** AgentPort’s imperative WebMCP harvesting and extension bridge, read-only static review

## Verdict

AgentPort is **not conformant enough to make an unqualified “WebMCP support” claim**, and ADR-006’s statement that every WebMCP-adopting site becomes compatible should be withdrawn. A defensible claim is: **“best-effort compatibility with imperative WebMCP registrations, including older MCP-B/early-Chrome shapes.”** AgentPort correctly prefers `document.modelContext`, preserves the basic `name`/`description`/`inputSchema`/`execute(input) → Promise<any>` shape, and accepts plain tool results. But it drops the current registration options, ignores origin and Permissions Policy semantics, misses declarative and pre-observed tools, does not propagate removal or re-registration into active sessions, supplies a materially nonconforming shim, and—most critically—auto-approves every harvested tool unless the page supplies an MCP-only `destructiveHint`. A current WebMCP write tool will ordinarily have no such field, so AgentPort converts a tool-description hint from an untrusted page into a fail-open authorization decision.

## 1. What WebMCP is today

The authoritative document is the **Web Machine Learning Community Group’s Draft Community Group Report dated 28 July 2026**. It is not a W3C Recommendation, not on the W3C Standards Track, and not a WHATWG or WICG standard. The draft itself says this explicitly. [WebMCP draft, 28 July 2026](https://webmachinelearning.github.io/webmcp/)

Implementation status is experimental:

- Chrome’s developer trial began at milestone 146; its origin trial is planned for 149–156; shipping was only estimated for 157 in the May 15 intent, not completed. Its WPT coverage was limited to IDL/basic use. [Blink intent, 15 May 2026](https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8/m/7Rx2_OOfBAAJ)
- Chrome announced the origin trial for Chrome 149 on 9 June 2026. [Chrome origin-trial announcement](https://developer.chrome.com/blog/ai-webmcp-origin-trial)
- Mozilla’s recorded position is **neutral**. [Mozilla standards position, opened 28 May 2026](https://github.com/mozilla/standards-positions/issues/1412)
- WebKit’s recorded position is **oppose**, with API-design, privacy, security, portability, venue, and meaningful-consent concerns. [WebKit standards position, opened 28 May 2026](https://github.com/WebKit/standards-positions/issues/670)
- TAG review was still pending in Chrome’s intent.

### Current location and recent changes

The current getter is:

```webidl
partial interface Document {
  [SecureContext, SameObject] readonly attribute ModelContext modelContext;
};
```

Chrome deprecated `navigator.modelContext` in Chrome 150 and directs sites to `document.modelContext`. [Chrome imperative API, updated 1 July 2026](https://developer.chrome.com/docs/ai/webmcp/imperative-api)

The change history is unusually important here:

- `provideContext()` and `clearContext()` were removed on **5 March 2026**.
- registration gained `AbortSignal` on **26 March**;
- `title` and MCP-compatible name requirements landed on **9 April**;
- `untrustedContentHint` landed on **23 April**;
- the getter moved to `Document` on **27 May**;
- `registerTool()` became promise-returning on **8 June**;
- the draft removed `ModelContextClient` on **11 June**.  
  [WebMCP specification commit history](https://github.com/webmachinelearning/webmcp/commits/main/index.bs)

AgentPort’s document-first/navigator-fallback probe is therefore sensible compatibility behavior. Its `provideContext()` model is not current WebMCP.

## 2. Current API and contracts

### ModelContext

The current interface is an `EventTarget` with:

```webidl
Promise<undefined> registerTool(
  ModelContextTool tool,
  optional ModelContextRegisterToolOptions options = {}
);
```

It also has `getTools(options)` and `ontoolchange`; there is no current `provideContext()`, `clearContext()`, public `unregisterTool()`, or `ModelContextClient`. [WebMCP API](https://webmachinelearning.github.io/webmcp/#api)

Unregistration is driven by the `AbortSignal` passed to registration. Registration rejects for duplicate names, invalid names, empty names/descriptions, non-serializable schemas, inactive documents, origin-keying failures, or Permissions Policy denial. The registration promise resolves only after the corresponding tool-change notifications have been queued. [WebMCP `registerTool`](https://webmachinelearning.github.io/webmcp/#dom-modelcontext-registertool)

`getTools()` returns the tools visible from the calling document and eligible descendants, sorted by name. Each `RegisteredTool` includes `name`, optional `title`, `description`, a **stringified** `inputSchema`, its owning `window`, its `origin`, and annotations. `fromOrigins` must be used for requested cross-origin descendants. [WebMCP `RegisteredTool`](https://webmachinelearning.github.io/webmcp/#registeredtool)

The only lifecycle event is currently `toolchange`. Declarative WebMCP is present as a section but is explicitly still a TODO in the normative draft; Chrome nevertheless experiments with a declarative form-oriented implementation. [WebMCP declarative and events sections](https://webmachinelearning.github.io/webmcp/#declarative-webmcp)

### Tool descriptor

| Field | Current WebMCP contract |
|---|---|
| `name` | Required `DOMString`; 1–128 ASCII alphanumeric, `_`, `-`, or `.`; unique in its model context |
| `title` | Optional `USVString`, intended for UI |
| `description` | Required non-empty `DOMString` |
| `inputSchema` | Optional object; exposed by `getTools()` as a stringified JSON Schema |
| `execute` | Required callback: `Promise<any>(object input)` |
| `annotations` | Optional `{readOnlyHint = false, untrustedContentHint = false}` |

The draft normatively references JSON Schema **2020-12**. Its present registration algorithm, however, principally specifies JSON serialization rather than comprehensive dialect validation; this portion should be treated as unfinished rather than assuming full validator semantics. [WebMCP descriptor IDL](https://webmachinelearning.github.io/webmcp/#modelcontexttool), [normative JSON Schema reference](https://webmachinelearning.github.io/webmcp/#normative-references)

### Result and error contract

A compliant `execute` callback returns a raw JavaScript value through `Promise<any>`—a string, object, array, or other supported value. It is **not required to return MCP’s** `CallToolResult` envelope. Chrome’s official example returns a plain string. [WebMCP callback IDL](https://webmachinelearning.github.io/webmcp/#callbackdef-toolexecutecallback), [Chrome plain-result example](https://developer.chrome.com/docs/ai/webmcp/imperative-api)

The current draft does not expose browser-agent execution as a web-facing method, so browser-agent error mapping and call cancellation remain implementation-defined. Chrome additionally implements `document.modelContext.executeTool(...)`, returning the raw callback result—or `null` after navigation—and accepts a call-level `AbortSignal`. **That method is current Chrome behavior, not part of the current WebMCP IDL.** [Chrome discovery and execution API](https://developer.chrome.com/docs/ai/webmcp/imperative-api#execute-tool)

By contrast, MCP requires a structured result such as `content`, optional `structuredContent`, and `isError`; it separately distinguishes protocol failures from tool-execution failures. [MCP tools specification, 25 November 2025](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

AgentPort’s result path is therefore mostly correct for current WebMCP: it forwards the page’s plain value and later converts it into MCP at the daemon in [mcp-bridge.ts](/Users/goga/Documents/goga/agentport/packages/daemon/src/mcp-bridge.ts:152). A page that follows older MCP-B examples and returns `{content, isError}` is not following a required WebMCP result shape; AgentPort will treat that envelope as ordinary data, JSON-wrap it again, and ignore the inner `isError`.

### Annotations

Current WebMCP has only:

- `readOnlyHint`, default `false`;
- `untrustedContentHint`, default `false`, indicating that output needs heightened handling against output/prompt injection. [WebMCP annotations](https://webmachinelearning.github.io/webmcp/#toolannotations)

`destructiveHint`, `idempotentHint`, and `openWorldHint` are **MCP annotations, not current WebMCP annotations**. MCP defaults them conservatively: destructive `true`, idempotent `false`, and open-world `true`. MCP also explicitly says annotations are untrusted hints unless supplied by a trusted server. [MCP annotation guidance, 16 March 2026](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)

## 3. Security and trust boundary

Normative WebMCP boundaries include:

- secure-context exposure;
- one model context per `Document`;
- rejection for inactive/non-origin-keyed documents;
- a `tools` Permissions Policy whose default allowlist is `'self'`;
- explicit `exposedTo` and `fromOrigins` controls for cross-origin frame trees;
- origin/window metadata passed to consumers.  
  [WebMCP origin and Permissions Policy model](https://webmachinelearning.github.io/webmcp/#permissions-policy-integration)

The security section is non-normative and explicitly says it cannot prescribe exact mitigations for agents and user agents. It identifies tool poisoning, output injection, intent misrepresentation, authenticated high-impact actions, cross-origin leakage, and over-parameterized tools that extract private agent context. It acknowledges that agents cannot verify whether a tool’s description matches its effects. [WebMCP security considerations](https://webmachinelearning.github.io/webmcp/#security-and-privacy-considerations)

WebMCP does **not** mandate:

- a specific connection-consent UI;
- per-call confirmation;
- a particular approval policy;
- a concrete rate limit;
- a transport or MCP wire representation;
- an agent identity or ownership model.

Chrome’s experiment instead assigns agents responsibility for protecting sensitive data, obtaining supervising-user consent, and mitigating prompt injection. [Blink security discussion](https://groups.google.com/a/chromium.org/g/blink-dev/c/gmYffo5WOE8/m/7Rx2_OOfBAAJ)

AgentPort’s architectural choice—consent and agent authority residing in the user’s wallet/daemon, outside the page—is compatible with that division and arguably stronger than WebMCP’s currently unspecified agent layer. The defect is narrower but serious: AgentPort lets untrusted page metadata relax the wallet’s authorization behavior.

## 4. Divergences, ordered by real-site breakage

### 1. Critical: approval gating uses a field current WebMCP does not define

**Spec says:** WebMCP provides `readOnlyHint` and `untrustedContentHint`; absence of `readOnlyHint: true` does not prove that a call is harmless. The security section warns that descriptions and declared intent may be deceptive.

**AgentPort does:** Both harvesters set `requiresApproval` only when raw `annotations.destructiveHint === true`; otherwise the tool is ungated. See [site harvester](/Users/goga/Documents/goga/agentport/site/src/webmcp.ts:85), [extension harvester](/Users/goga/Documents/goga/agentport/packages/extension/src/inpage.ts:371), and the test that deliberately blesses an unannotated write in [webmcp-harvest.ts](/Users/goga/Documents/goga/agentport/scripts/webmcp-harvest.ts:75).

**What breaks:** A normal spec-compliant `addTodo`, `purchase`, `delete`, or `changeAccount` tool has no `destructiveHint`, so one attachment grant authorizes model-controlled calls without per-call approval. Even an explicit `destructiveHint: false` would be untrusted page testimony.

**Fix:** Fail closed: require per-call approval unless `readOnlyHint === true` and a trusted user-side origin policy permits auto-approval; use `untrustedContentHint` to taint results, and display origin, tool, and concrete arguments in approval UI.

### 2. High: wrappers discard all registration options

**Spec says:** `registerTool(tool, {signal, exposedTo})` uses the signal for unregistration and `exposedTo` for cross-origin visibility.

**AgentPort does:** Its wrappers accept only `tool` and call the native method as `registerTool.call(this, tool)`, dropping the second argument. [webmcp.ts](/Users/goga/Documents/goga/agentport/site/src/webmcp.ts:67), [inpage.ts](/Users/goga/Documents/goga/agentport/packages/extension/src/inpage.ts:430)

**What breaks:** React/component lifecycle unregistration does not occur in the native registry, and cross-origin tools lose their author-declared exposure. AgentPort’s private registry also never learns when the signal aborts.

**Fix:** Forward `...args` byte-for-byte, register an abort listener in the harvesting layer, and remove/publish the harvested tool atomically when the signal aborts.

### 3. High: AgentPort adopts tools before native registration succeeds

**Spec says:** Duplicate, invalid, disallowed, detached-document, or unserializable registrations reject.

**AgentPort does:** It inserts into a `Map` before calling the native method; duplicate names silently replace previous entries, and incomplete descriptors receive synthesized descriptions/schemas.

**What breaks:** The agent can see and call a tool that the browser rejected and that no compliant WebMCP consumer can see. A failed re-registration may also overwrite AgentPort’s working callback while leaving the native tool unchanged.

**Fix:** Adopt only after the returned registration promise fulfills; on synchronous failure or rejection, leave the harvested registry untouched and surface/log the failure.

### 4. High: active grants are snapshots; registration and removal do not reach the agent

**Spec says:** tools can be added or removed during a document’s life, removal is signal-driven, and `toolchange` notifies consumers.

**AgentPort does:** The extension publishes updated definitions to the content script, but a connected session’s `routes` and capability grant are created once from the attach/resume request. [content.ts](/Users/goga/Documents/goga/agentport/packages/extension/src/content.ts:219), [connection snapshot](/Users/goga/Documents/goga/agentport/packages/extension/src/content.ts:234)

**What breaks:** Newly mounted SPA tools remain unavailable. Removed tools remain advertised and callable through retained callbacks. Role/account changes can leave stale privileges in the session.

**Fix:** Implement versioned, atomic grant updates: remove routes immediately on unregistration, re-consent before adding authority, and emit the equivalent of MCP `tools/list_changed` to the runtime.

### 5. High: standard discovery is not used, so declarative, early, and descendant tools are missed

**Spec says:** `getTools()` exposes the current visible registry, including eligible descendants; Chrome’s implementation can expose declaratively synthesized tools through that registry.

**AgentPort does:** It monkey-patches imperative registration. It neither calls `getTools()` nor invokes Chrome’s `executeTool()`. The comment claiming WebMCP has no public registry is now obsolete. [webmcp.ts](/Users/goga/Documents/goga/agentport/site/src/webmcp.ts:37)

**What breaks:** Tools registered before interception, Chrome declarative tools, and tools discoverable through a frame-tree observation may not be harvested. The extension may report no WebMCP support and fall back to generic DOM tools on a genuine WebMCP page.

**Fix:** Prefer native `getTools()` for reconciliation and native `executeTool()` for invocation when available; retain interception only to capture callback references where the browser offers no browser-agent execution bridge.

### 6. High: origin, frame, and Permissions Policy semantics are discarded

**Spec says:** registered tools carry owner `window` and `origin`; cross-origin visibility requires Permissions Policy plus `exposedTo`/`fromOrigins`.

**AgentPort does:** The bridge reduces tools to name, description, schema, and `requiresApproval`. [bridge.ts](/Users/goga/Documents/goga/agentport/packages/extension/src/bridge.ts:217) It injects into all HTTP(S) frames, intercepts local registrations, and supplies neither owner-origin metadata nor spec exposure filtering to the daemon.

**What breaks:** Cross-origin tools can be missing, misattributed, collide by name, or be exposed to the remote agent contrary to the author’s intended frame-origin audience. Approval UI cannot explain which frame owns the effect.

**Fix:** Namespace tools by document/frame identity, preserve owner origin, honor Permissions Policy and exposure filters, and include origin in grants, prompts, logs, and approvals.

### 7. Medium-high: the fallback shim is not a WebMCP polyfill

**Spec says:** `ModelContext` is an `EventTarget`; `registerTool()` returns `Promise<undefined>`; it supports options, `getTools()`, `ontoolchange`, validation, document lifecycle, and secure/origin restrictions.

**AgentPort does:** The shim implements obsolete `provideContext()`, returns `{unregister()}` from `registerTool()`, installs itself on both `document` and `navigator`, and omits the rest. [inpage.ts](/Users/goga/Documents/goga/agentport/packages/extension/src/inpage.ts:440)

**What breaks:** Code using signals, `getTools`, events, origin exposure, promise rejection, duplicate detection, or standard lifecycle semantics behaves differently under AgentPort than in Chrome.

**Fix:** Either provide a standards-shaped polyfill with tests against the current IDL/WPTs, or do not install a model-context shim and expose AgentPort compatibility through a clearly separate API.

### 8. Medium: navigation and call cancellation stop only AgentPort’s waiter

**Spec/common implementation says:** the draft scopes tools to a fully active `Document`; Chrome’s `executeTool()` supports `AbortSignal` and treats navigation specially.

**AgentPort does:** A daemon cancellation or 30-second timeout rejects/settles the remote call, but no cancellation reaches the page callback. [content.ts](/Users/goga/Documents/goga/agentport/packages/extension/src/content.ts:334)

**What breaks:** An expensive or destructive callback can continue after the user cancels, the agent times out, or navigation makes the result irrelevant. A resumed session can retain a grant whose owning document no longer exists.

**Fix:** Cancel pending calls on `beforeunload`; use native `executeTool(..., {signal})` when available; otherwise add an AgentPort call-context signal and require fresh document-tool reconciliation before resume.

### 9. Medium: descriptor fidelity and validation are incomplete

**Spec says:** `title`, `origin`, `window`, `readOnlyHint`, and `untrustedContentHint` are meaningful fields; name and description validity is enforced.

**AgentPort does:** It drops `title`, both current annotations, origin/window, and exposure data; it substitutes the name for missing descriptions and `{type:"object"}` for absent or invalid schemas. Its bridge silently filters malformed and duplicate definitions. [bridge.ts](/Users/goga/Documents/goga/agentport/packages/extension/src/bridge.ts:217)

**What breaks:** UI labels degrade, prompt-injection taint is lost, malformed tools appear valid, and the remote agent cannot implement origin-aware policy.

**Fix:** Preserve all current metadata, distinguish “omitted” from “invalid,” validate consistently with WebIDL/registration semantics, and surface rejection or truncation instead of silently repairing it.

### 10. Medium-low: WebMCP permits `any`; AgentPort effectively requires wire-safe JSON

**Spec says:** a callback returns `Promise<any>`.

**AgentPort does:** Values eventually cross structured messaging and AgentPort’s JSON wire, then the daemon calls `JSON.stringify` to construct MCP text. [mcp-bridge.ts](/Users/goga/Documents/goga/agentport/packages/daemon/src/mcp-bridge.ts:168)

**What breaks:** Non-JSON values—cycles, `BigInt`, some platform objects, and values whose structured-clone and JSON behavior differ—may fail or be lossy even though the WebMCP callback type admits them.

**Fix:** Define and enforce an explicit JSON-compatible AgentPort result subset at the boundary with a visible tool error, or implement a documented structured-clone-to-MCP conversion.

### 11. Low for current spec, medium for older ecosystem compatibility: MCP result envelopes are double-wrapped

**Common implementation does:** MCP-B documentation still shows callbacks returning `{content:[{type:"text",…}]}`. [MCP-B extension documentation](https://docs.mcp-b.ai/concepts/extension)

**AgentPort assumes:** every page result is a plain value and creates the MCP envelope in the daemon.

**What breaks:** An older MCP-B tool’s `content`, `structuredContent`, and `isError` become nested data; inner error signaling is ignored.

**Fix:** Keep raw values as the normative WebMCP path, but add an explicitly labeled MCP-B compatibility normalizer that recognizes and validates `CallToolResult` rather than guessing for all objects.

### 12. Low: undocumented hard caps silently change the visible registry

**Spec says:** it currently imposes a 128-character name bound but no fixed 64-tool registry maximum or equivalent AgentPort payload limit.

**AgentPort does:** The bridge takes only the first configured number of tools, limits descriptions and JSON size, and silently drops invalid/duplicate entries. [bridge.ts](/Users/goga/Documents/goga/agentport/packages/extension/src/bridge.ts:231)

**What breaks:** Large applications receive a partial capability set without knowing which registrations disappeared.

**Fix:** Keep defensive limits, but reject or visibly report truncation with counts/names and make the attachment incomplete rather than silently authoritative.

### 13. Documentation and tests certify the obsolete contract

The harvest script models `provideContext()` and an `{unregister()}` return handle, while explicitly asserting that unannotated write-like tools are ungated. [webmcp-harvest.ts](/Users/goga/Documents/goga/agentport/scripts/webmcp-harvest.ts:4)

The report describes `provideContext()` as part of the reference contract and limits approval to `destructiveHint`. [webmcp-harvest-report.md](/Users/goga/Documents/goga/agentport/docs/webmcp-harvest-report.md:1)

ADR-006 correctly records the document/navigator move, but overstates implementation and ecosystem status. [ADR-006](/Users/goga/Documents/goga/agentport/docs/ADR.md:150)

**Fix:** Replace the existing harvest fixture with current-IDL conformance cases: promise registration, duplicate rejection, option forwarding, signal removal, `toolchange`, origin exposure, title/current annotations, raw result values, navigation cancellation, declarative/pre-existing discovery, and active-grant reconciliation.

## 5. What AgentPort should steal from neighboring work

- **MCP:** Keep MCP conversion at the daemon boundary, but adopt its explicit result/error distinction, `tools/list_changed`, output-schema handling, and human-in-the-loop guidance. Treat annotations as untrusted evidence, not authorization. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

- **MCP-B:** Copy its origin validation on every transport message, tab/context-aware routing, page-lifecycle monitoring, interrupted responses on `beforeunload`, stale-request cleanup, and extension-port reconnection. Its `navigator` spelling and MCP-shaped callback result are legacy/common behavior, not the current WebMCP contract. [MCP-B architecture](https://docs.mcp-b.ai/concepts/extension), [MCP-B transport lifecycle and security](https://docs.mcp-b.ai/packages/transports/reference)

- **Chrome’s WebMCP implementation:** Prefer registry observation plus mediated execution over method monkey-patching. `getTools`, `toolchange`, owner-origin metadata, `AbortSignal`, `exposedTo`, `fromOrigins`, and Permissions Policy form a coherent lifecycle and origin boundary. [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)

- **Prompt API:** Its tool callback returns a plainly specified string, while prompt/session operations are abortable. The useful lesson is not to copy its exact result type, but to specify one conversion boundary and make cancellation reach the operation doing the work. [Prompt API draft, 3 August 2026](https://webmachinelearning.github.io/prompt-api/)

- **Harbor/Web Agent API:** Copy effect-classified actions, origin-scoped capability tokens, TTLs and budgets, plan/execute/watch modes, non-widening delegation, explicit revocation, and an audit trail explaining policy decisions. Harbor is a May 2026 draft by people inside Mozilla, explicitly not a Mozilla product or standards position. [Harbor Web Agent API draft](https://r.github.io/Harbor/spec.html)

- **Web User Agent principles:** AgentPort is a user agent in the broader sense. Its wallet should visibly communicate origin, active authority, invocation, and consequences; protection, honesty, and loyalty to the user should override page convenience. [W3C Web User Agents](https://www.w3.org/TR/web-user-agents/)

## Recommended claim after remediation

Until items 1–7 are fixed:

> AgentPort experimentally harvests basic imperative WebMCP-style registrations, with compatibility for both `document.modelContext` and older `navigator.modelContext` integrations. Full current-draft, declarative, lifecycle, and cross-origin conformance is not yet implemented.

After those fixes, a claim of **“current imperative WebMCP interoperability”** would be supportable. “Full WebMCP conformance” should wait for a stable declarative specification, representative WPT coverage, and browser-agent execution semantics.

## Model, effort, and uncertainty

- **Model:** `gpt-5.6-sol`
- **Reasoning effort:** high
- **Method:** primary-source web research plus read-only static inspection of the specified repository files and the adjacent session/MCP conversion paths.
- **Uncertainty:** Medium. The imperative IDL and annotation mismatch are high-confidence findings. WebMCP is changing rapidly; declarative WebMCP remains explicitly unfinished, Chrome’s `executeTool()` is ahead of the Community Group IDL, and the planned Chrome 157 shipping status may change. MCP-B documentation represents common/legacy implementation behavior, not normative WebMCP.