# @agentport/agui implementation report

## Outcome

Added `@agentport/agui`, a zero-runtime-dependency adapter from a live
`AgentSession` to AG-UI-compatible events. It exposes both requested forms:

- `aguiStream(session) -> { events: AsyncIterable<AguiEvent>, run(text): Promise<string> }`
- `onAguiEvent(session, callback) -> unsubscribe`

The implementation imports only types and runtime behavior from
`@agentport/client`. It uses no DOM, React, Node, network, or storage APIs, so
the package code can run in browsers and Node. The executable check is
intentionally Node-only test code and is outside the package TypeScript build.

## Event mapping

| AgentPort source | AG-UI output | Details |
|---|---|---|
| `aguiStream(...).run(text)` | `RUN_STARTED` | `threadId` is `session.id`; the adapter generates a run id. The event is emitted before `session.prompt(text)` is called. |
| Successful prompt completion | `RUN_FINISHED` | Uses the same generated run id and exposes the resolved assistant text as `result`. |
| Prompt `done` with `stopReason: "error"`, prompt rejection, or closure during a run | `RUN_ERROR` | `message` carries the error. Current AG-UI `RUN_ERROR` has no `runId`, so the generated id is retained in `rawEvent.runId`. |
| `delta { promptId, text }` | first chunk: `TEXT_MESSAGE_START`; every non-empty chunk: `TEXT_MESSAGE_CONTENT` | `messageId` is the AgentPort `promptId`; role is `assistant`; content uses `delta`. Empty chunks are ignored because AG-UI content deltas must be non-empty. |
| prompt `done` after text | `TEXT_MESSAGE_END` | Closes the message identified by `promptId` before the run terminal event. |
| `thought { promptId, text }` | first chunk: `REASONING_START` + `REASONING_MESSAGE_START`; every non-empty chunk: `REASONING_MESSAGE_CONTENT` | Uses the current AG-UI reasoning vocabulary. Deprecated `THINKING_*` names are not emitted. The reasoning message id is `${promptId}:reasoning`. No `STEP_*` event is invented because AgentPort supplies neither a step name nor step boundaries. |
| prompt `done` after thought | `REASONING_MESSAGE_END` + `REASONING_END` | Closes the visible reasoning stream before the run terminal event. |
| `tool { name, arguments, ok, result?, error? }` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` | AgentPort currently emits one post-execution event and drops the wire call id, so the adapter generates `toolCallId` and serializes the complete arguments object as the single args delta. AG-UI's `TOOL_CALL_END` has no outcome fields, and a failed tool is not necessarily a failed run; the AgentPort execution outcome is therefore preserved in the standard `rawEvent` field on `TOOL_CALL_END`. |
| `approval { summary, call?, granted }` | `CUSTOM`, name `agentport.approval` | AG-UI custom events use `type: "CUSTOM"` plus an application-defined `name`. The value is the full AgentPort approval event. This is an observation emitted after AgentPort has made the decision, not an alternate authority path. Approval authority remains in AgentPort as required by ADR-017. |
| `closed { reason }` | `CUSTOM`, name `agentport.closed`, then stream completion | Any open text/reasoning frames are closed first, and open runs receive `RUN_ERROR`. The callback subscription tears down its AgentSession listeners. |
| direct `session.prompt()` observed by `onAguiEvent` | lazy `RUN_STARTED` on the first prompt-scoped event | `AgentSession` exposes no prompt-start event or prompt id from `prompt()`. The callback-only adapter establishes a well-formed run as soon as the first `delta`, `thought`, or `done` reveals the prompt id. Consumers needing start-at-call semantics should use `aguiStream().run()`. |
| `session.history()` / history reply | no event | `AgentSession` does not emit history through `SessionEvents`; it resolves a separate promise. No state or message snapshot is fabricated. |
| `session.cancel(promptId)` | no immediate event | Cancellation is a command. A later non-error `done` closes the message/reasoning and finishes the run. AG-UI has no stable cancellation terminal event in the targeted vocabulary. |
| `session.info.agentName` / `runtime` | no event | These remain attachment metadata on the passed `AgentSession`, not agent output. |
| `session.info.verify` fingerprint words | deliberately no AG-UI event | These words authenticate the sealing-key exchange and must be rendered/checked at AgentPort's connection-consent boundary. Treating them as ordinary agent output would blur trust UI with transcript UI; callers still have the original `session.info.verify`. |

## AG-UI types

`@ag-ui/core` was not used. `npm view @ag-ui/core version --offline` returned
`ENOTCACHED`, and `npm cache ls '@ag-ui/*'` found no cached package. Adding an
uncached external dependency would violate the task's offline/zero-dependency
constraint.

The package therefore exports local structural event types using the official
AG-UI literals and fields. The definitions were checked against the current
AG-UI TypeScript event reference on 2026-08-02. In particular:

- lifecycle: `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`
- text: `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`
- tools: `TOOL_CALL_START`, `TOOL_CALL_ARGS`, `TOOL_CALL_END`
- reasoning: `REASONING_START`, `REASONING_MESSAGE_START`,
  `REASONING_MESSAGE_CONTENT`, `REASONING_MESSAGE_END`, `REASONING_END`
- extensions: AG-UI `CUSTOM` with names `agentport.approval` and
  `agentport.closed`

The local events include AG-UI's optional `timestamp` and `rawEvent` base
fields. The adapter does not stamp timestamps because AgentPort session events
do not carry source timestamps and receipt time would imply false precision.

## Files

Created:

- `packages/agui/package.json`
- `packages/agui/tsconfig.json`
- `packages/agui/src/index.ts`
- `packages/agui/check.ts`
- `packages/agui/REPORT.md`

Modified only for root project wiring:

- `tsconfig.json` — added the `packages/agui` project reference

The pre-existing `package-lock.json` license-line modification was not touched.
The root workspace glob already includes `packages/*`, so no workspace edit was
needed.

## Commands and results

| Command | Result |
|---|---|
| `npm view @ag-ui/core version --offline` | Expected discovery result: `ENOTCACHED`; no offline package was available. |
| `npm run typecheck` | Passed: `tsc -b --force` exited 0, including the new package reference. Run twice after final edits. |
| `npx tsx packages/agui/check.ts` | The sandbox rejected tsx's internal Unix-domain IPC listener before loading the test: `listen EPERM .../tsx-501/...pipe`. |
| `node --import tsx packages/agui/check.ts` | Passed: `@agentport/agui check passed (18 streamed events)`. This executes the same TypeScript check through tsx without the CLI IPC helper. |
| `npm run e2e` | The same tsx IPC listener was rejected by the sandbox before the suite loaded. |
| `node --import tsx scripts/e2e.ts` | The suite loaded, but the sandbox rejected the relay's required loopback listener: `listen EPERM 127.0.0.1`. The e2e suite therefore could not execute in this environment; no passing claim is made. |

The package-local check constructs a real `AgentSession` with a fake `send`,
extracts the generated prompt ids from sent frames, feeds frames through
`session.handle(...)`, and asserts the exact 18-event sequence. It covers a
thought, two text deltas with start/end framing, a successful tool call and
captured result, an approval decision, a successful run, an error run, stream
closure, and the callback subscription form.

## Uncertainty and spec-fidelity risks

- The AG-UI spec and SDK are still changing. Local types can drift until
  `@ag-ui/core` becomes available and replaces them. The most visible recent
  drift is `THINKING_*` becoming deprecated in favor of `REASONING_*`.
- AgentPort's public `tool` event is lossy for AG-UI: it arrives only after
  execution, has no original call id, no prompt/parent-message id, and combines
  call and result. Generated ids and `rawEvent` preserve validity and data but
  cannot recreate the original streaming timing. Renderers that ignore
  `rawEvent` will not display tool success/result/error.
- `AgentSession` emits `approval` only after its decider resolves. The custom
  event is an audit/rendering signal, not an interactive AG-UI approval request.
  That limitation is intentional for authority safety, but generic AG-UI HITL
  widgets cannot use this event to decide the approval.
- AG-UI lifecycle events are designed around one run stream. Concurrent
  `run()` calls can interleave content events; AgentPort does not expose the
  prompt id from `prompt()` soon enough to establish a stronger per-run stream
  association. Sequential runs have exact framing and are the tested path.
- The mandated e2e proof is incomplete solely because this sandbox disallows
  both Unix sockets used by the tsx CLI and TCP listeners used by the real
  relay. It should be rerun outside this sandbox as `npm run e2e`.

## Future ACP-to-AG-UI bridge seam (not implemented)

The ecosystem now has the open-source
`namanrajpal/acp-to-agui` project, which translates ACP JSON-RPC/stdio updates
to AG-UI over SSE. AgentPort could later evaluate reusing its translation logic
inside `packages/daemon/src/runtimes/acp.ts`, where `AcpRuntime` currently
normalizes ACP session updates into AgentPort runtime callbacks. That could
yield richer tool/diff/terminal events before the current `AgentSession` API
collapses them. Adopting its SSE transport directly would require revisiting
ADR-017's client-edge adapter decision and is not implied here.

That bridge cannot replace AgentPort's trust/provenance seams:

- token-scoped `McpBridge` capability injection through ACP `mcpServers` at
  `session/new` and `loadSession`, derived from the live AgentPort grant;
- `loadSession`-based history restoration from the user's own agent store and
  the daemon's AgentPort-session-to-ACP-session mapping;
- AgentPort approval authority, including daemon/client routing, `alwaysAsk`,
  grant enforcement, and the rule that a poisoned tool result cannot approve a
  destructive action;
- sealed session transport, identity, resume authority, fingerprints, and
  participant checks.

In short, it may replace event-shape translation; it cannot replace the
capability, provenance, consent, or transport middle that ADR-004/017 reserve
for AgentPort.
