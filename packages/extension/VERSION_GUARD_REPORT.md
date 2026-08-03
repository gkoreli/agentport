# Extension version-guard report

## Files changed

- `build.ts` reads the root `package.json`, validates its Chrome-compatible numeric version, defines `__AGENTPORT_VERSION__` for every esbuild target, and replaces the copied manifest placeholder before the build completes.
- `static/manifest.json` now carries a `0.0.0` placeholder plus an explicit build-stamping note; neither survives in `dist/manifest.json`.
- `src/version.ts` is the single source-level access point for the esbuild version stamp.
- `src/inpage.ts` exposes the stamped `version` and integer `contract`, defines `CONTRACT_REVISION`, preserves the worker's typed rejection detail, and publishes type-only aliases for conformance checking.
- `src/bridge.ts` adds typed content/worker hello frames and the `ExtensionProviderErrorReason` union, including `extension_updating`, through both bridge legs.
- `src/content.ts` sends its stamp as the first worker-port frame, verifies the worker reply, emits a structured mismatch warning, preserves typed provider reasons, and logs failed worker sends.
- `src/sw.ts` verifies the content stamp, returns its own stamp and compatibility bit, emits structured warnings with both versions and request context, and refuses requests on incompatible ports with `extension_updating`.
- `src/popup.ts` displays the running stamped version in Settings.
- `src/conformance.ts` contains type-only compile-time assertions for the page session and injected provider seams.
- `check.ts` retains the boundary checks and adds built-artifact checks for the in-page stamp, the `dev` sentinel, the dist manifest version, and placeholder leakage.
- `tsconfig.json` includes `check.ts`; `src/**/*.ts` includes `src/conformance.ts` in every extension typecheck.
- `package.json` drops the private extension workspace's redundant local version; the root release version is now the only extension-binary version source. Existing `0.0.1` dependency constraints remain dependency metadata, not binary stamps.

## Conformance assertion pattern

```ts
import type { AgentProvider, AgentSessionHandle } from '@agentport/client';
import type { InjectedProvider, PageSessionInstance } from './inpage.js';

type AssertAssignable<Expected, Actual extends Expected> = Actual;

type PageSessionConformsToClient = AssertAssignable<AgentSessionHandle, PageSessionInstance>;
type InjectedProviderConformsToClient = AssertAssignable<AgentProvider, InjectedProvider>;
```

The provider literal also uses `satisfies AgentProvider & { readonly contract: number; ... }`, preserving its concrete inferred type for the second assertion.

## Proof greps

```text
$ rg -n "0\.0\.1|version:\s*['\"]0\.0\.1['\"]|\"version\"\s*:\s*\"0\.0\.1\"" \
    packages/extension/src packages/extension/static packages/extension/build.ts packages/extension/check.ts
(no matches)

$ rg -n -o "0\.0\.3" packages/extension/dist/{inpage,content,sw,popup}.js
packages/extension/dist/inpage.js:48:0.0.3
packages/extension/dist/content.js:1491:0.0.3
packages/extension/dist/sw.js:4280:0.0.3
packages/extension/dist/popup.js:1279:0.0.3

$ sed -n '1,5p' packages/extension/dist/manifest.json
{
  "manifest_version": 3,
  "name": "AgentPort",
  "version": "0.0.3",
  "description": "Bring your own agent to any website. navigator.agent, with the wallet outside the page.",
```

## Verification output

```text
$ cd packages/extension && npm run typecheck
> typecheck
> tsc -p tsconfig.json

$ cd packages/extension && node --import tsx build.ts && node --import tsx check.ts
[agentport] extension built → .../packages/extension/dist
extension boundary check passed
extension build stamp check passed (0.0.3)

$ npm run typecheck
> agentport@0.0.3 typecheck
> tsc -b --force
```

The requested `npx tsx check.ts` entry point is present and uses no new dependency. In this managed sandbox, the `tsx` CLI itself aborts before loading the script because Unix-socket creation returns `EPERM` (`.../tsx-501/*.pipe`). Running the same installed `tsx` loader through `node --import tsx check.ts` bypasses only that CLI IPC layer and produced the passing output above. The same sandbox limitation affects `npm run build` because that script invokes the `tsx` CLI; `build.ts` itself completed successfully through the loader.

## Risks

- `CONTRACT_REVISION` is deliberately manual. Type drift fails compilation, but a semantically incompatible behavior change with an unchanged TypeScript shape still requires the revision to be bumped during review.
- The build intentionally rejects non-numeric root versions because Chrome manifest versions accept numeric components. A future prerelease release scheme will need a separate Chrome-version mapping rather than silently emitting an invalid manifest.
- Mid-update behavior depends on Chrome runtime ports preserving message order: the content `hello` is posted before the first request. The worker also rejects a request received without a completed compatible hello, so reordered or missing handshakes fail closed.
