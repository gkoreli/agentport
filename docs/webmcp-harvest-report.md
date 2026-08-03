# WebMCP harvesting report

## API shapes harvested

The implementation follows the repository's existing extension integration,
not an independently fetched specification:

- A model context exposes `registerTool(tool)` and
  `provideContext({ tools })`. The reference is
  `packages/extension/src/inpage.ts:389`; the extension's shim behavior is at
  `packages/extension/src/inpage.ts:429`.
- Each accepted registration has a string `name`, optional string
  `description`, optional object `inputSchema`, callable `execute(args)`, and
  optional `annotations`. The reference shape is
  `packages/extension/src/inpage.ts:349`, and its conversion into a `SiteTool`
  is at `packages/extension/src/inpage.ts:357`.
- The resulting AgentPort-side shape is `{ name, description, inputSchema,
  handler, requiresApproval? }`, matching the generic `SiteTool`s in
  `packages/extension/src/pagetools.ts:122`. Function handlers remain in the
  page world; only definitions cross the extension boundary, and content-side
  routing returns calls to the page (`packages/extension/src/content.ts:278`).
- `provideContext({ tools })` replaces the harvested set; `registerTool(tool)`
  adds or replaces one entry by name. `document.modelContext` is selected
  first, with `navigator.modelContext` used only when the document spelling is
  absent or unusable. These compatibility semantics implement ADR-006
  (`docs/ADR.md:144`).

## Files changed

- `site/src/webmcp.ts` — browser-safe registration observation, WebMCP-to-
  `SiteTool` conversion, and explicit-wins merging.
- `site/src/connect.ts` — snapshots and merges harvested tools at connect and
  resume time before creating the session grant.
- `site/tsconfig.json` — includes the drop-in and harvester in the requested
  site typecheck.
- `packages/extension/src/inpage.ts` — probes the document spelling first,
  preserves the navigator fallback/two-spelling shim, applies the gating
  policy, and merges harvested tools into page-declared connect/resume grants.
- `packages/extension/src/content.ts` — makes the existing harvested-tool count
  label spelling-neutral (`WebMCP`).
- `packages/extension/src/bridge.ts` — updates the boundary comment for both
  model-context spellings.
- `packages/extension/README.md` — documents probe order, execution location,
  shim behavior, and gating.
- `scripts/webmcp-harvest.ts` — focused plain-object check for two document
  registrations, execution, collision precedence, gating, and navigator
  fallback.
- `AGENTS.md` — marks State of things item 4 complete.
- `docs/webmcp-harvest-report.md` — this report.

The pre-existing `package-lock.json` license-line modification was left
untouched. `site/src/inkwell.ts` and `site/src/agentport-ui.ts` were not
modified.

## Gating policy

A harvested tool receives `requiresApproval: true` only when
`annotations.destructiveHint === true`, the destructive annotation present in
the in-repo registration shape. Unannotated tools are not gated, even when the
name sounds like a write. This follows the task's policy that the site chose to
publish the tool. Explicit `SiteTool`s retain their own `requiresApproval`
value and replace harvested tools with the same name.

## Verification

Passing commands and output:

```text
$ node --import tsx scripts/webmcp-harvest.ts
1. document.modelContext
  ok   harvests both registered tools
  ok   prefers document over navigator
  ok   maps definition fields
  ok   gates an explicit destructiveHint
  ok   does not gate an unannotated/read-only tool
  ok   execute() round-trips through handler

2. explicit collision
  ok   explicit tool wins on name collision
  ok   collision leaves one tool with that name

3. navigator.modelContext fallback
  ok   uses navigator when document.modelContext is absent
  ok   does not gate a write-sounding name without an annotation
  ok   fallback execute() round-trips

WebMCP harvest passed

$ npm run typecheck
> tsc -b --force

$ npx tsc -p site/tsconfig.json
# no output; exit 0

$ cd packages/extension && npm run typecheck
> tsc -p tsconfig.json

$ node --import tsx packages/extension/build.ts
# inpage.js, content.js, consent.js, popup.js, and sw.js built; exit 0

$ node --import tsx site/build.ts
# connect.js, inkwell.js, and tasker.js built; exit 0

$ git diff --check
# no output; exit 0
```

The requested `npx tsx scripts/webmcp-harvest.ts`, extension `npm run build`,
and `npm run e2e` commands could not get past this execution sandbox's Unix
socket restriction. Each failed before loading project code with
`listen EPERM .../tsx-501/*.pipe`. The equivalent Node `tsx` loader was used
for the harvest and build checks above.

The e2e loader fallback also cannot run here:

```text
$ node --import tsx scripts/e2e.ts
Error: listen EPERM: operation not permitted 127.0.0.1
```

Therefore the full real-socket e2e result is unverified in this sandbox and
must be run in an environment that permits a loopback listener.

## Uncertainty and risks

- WebMCP exposes registration calls rather than an enumerable registry in the
  in-repo shape. The observers must load before registrations they need to
  capture. The normal native-API path satisfies this because model context
  exists before page scripts and connect.js/the extension observes it early;
  a late polyfill that installs and registers everything before AgentPort loads
  cannot be reconstructed afterward.
- Chrome's move from navigator to document and the cited version timing came
  from the task/ADR. Per instruction, it was not independently checked against
  the network. Browser implementation details may continue to drift.
- The code assumes `registerTool` and `provideContext` can be shadowed on the
  model-context object, as the existing extension implementation did. A future
  implementation with non-writable methods would need a different interception
  seam.
- Only the in-repo `destructiveHint` annotation affects gating. New destructive
  annotation spellings will remain ungated until explicitly mapped.
