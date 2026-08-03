# Structured logging implementation report

## Files changed

- `AGENTS.md` — added the binding error/logging rules immediately after Tenets.
- `packages/protocol/src/log.ts` — added the zero-dependency, browser-safe structured logger, global bounded ring, threshold resolution, child loggers, sinks, and safe throwable normalization.
- `packages/protocol/src/index.ts` — exported the logging API from the shared protocol package.
- `packages/client/src/wallet.ts` — replaced the string log callback with a structured sink/logger and added contextual socket/frame logging.
- `packages/client/src/session.ts` — passed a child `Logger` into sessions and logged approval/tool-handler failures with session context.
- `packages/daemon/src/daemon.ts` — replaced `options.log`/`#log`, guarded async socket/session boundaries, and added contextual runtime/session failure logs.
- `packages/daemon/src/runtimes/acp.ts` — replaced its callback logger, structured ACP lifecycle/stderr failures, and caught cancellation failures.
- `packages/daemon/src/mcp-bridge.ts` — added structured request/tool logging and caught the HTTP handler's promise boundary.
- `packages/daemon/src/index.ts` — exported `McpBridgeOptions` with its new sink escape hatch.
- `packages/daemon/src/cli.ts` — installed fatal process handlers and routed daemon diagnostics through `daemon.cli`.
- `packages/daemon/src/connect-cli.ts` — installed fatal process handlers and routed connect-command diagnostics through `daemon.connect-cli`.
- `packages/relay/src/core.ts` — replaced its callback logger and attached identity/session context to routing failures and lifecycle events.
- `packages/relay/src/relay.ts` — replaced the callback option with a sink and logged peer socket failures.
- `packages/relay/src/cli.ts` — installed fatal process handlers and routed startup/shutdown diagnostics through `relay.cli`.
- `packages/cli/src/main.ts` — routed published CLI service-install errors through the shared logger.
- `site/src/observe.ts` — installed page-level error/rejection observers once and exposed `window.__agentport.logs()`.
- `site/src/connect.ts` — replaced console diagnostics, logged and surfaced connection/resume failures, and imported the page observer.
- `site/src/agentport-ui.ts` — replaced console diagnostics while preserving visible panel failure notices.
- `site/src/relay-do.ts` — removed the relay string callback and logged closed-socket sends through `relay.worker`.
- `packages/extension/src/sw.ts` — replaced the wallet callback, installed service-worker last-resort handlers, and caught/logged fire-and-forget Chrome, storage, reconnect, prompt, and UI boundaries while preserving UI replies/denials.
- `scripts/e2e.ts` — migrated log suppression from the deleted callback API to structured sinks.
- `scripts/acp-smoke.ts` — removed legacy logger callbacks and uses the shared default sink.
- `scripts/integration.ts` — removed legacy logger callbacks and uses the shared default sink.
- `scripts/log-check.ts` — added the focused ten-assertion logger check.
- `docs/structured-logging-report.md` — recorded implementation and verification evidence.

## Legacy-path removal evidence

The following repository-wide search produced no matches (expected `rg` exit 1):

```sh
rg -n "\b(log|sink)\??:\s*\(message: string\)|\blog:\s*\([^)]*\)\s*=>|options\.log|#log:\s*\(message" --glob '*.ts' .
```

The following search over the production targets also produced no matches:

```sh
rg -n "console\.(error|warn|info|debug)" \
  packages/client/src packages/daemon/src packages/relay/src \
  packages/cli/src/main.ts site/src/connect.ts site/src/agentport-ui.ts \
  packages/extension/src/sw.ts
```

Intentional `console.log` calls remain only for human-facing CLI presentation and test/check output; they are not a parallel diagnostic logging path.

## AGENTS.md section as landed

```md
## Errors and logging

- Every catch block either rethrows or logs through the shared logger with a
  component and relevant context. A bare `catch {}` requires a comment proving
  that silence is safe.
- Errors that cross an async boundary (event handlers, fire-and-forget
  promises, socket callbacks) MUST be caught and logged. A floating promise
  rejection is a bug.
- User-visible failures are logged AND surfaced in the UI. Log-only is not
  surfacing.
- New subsystems accept a `Logger` (or use `createLogger`), never a bare string
  callback.
- Raise verbosity with `AGENTPORT_LOG=debug` in Node or
  `localStorage['agentport.log'] = 'debug'` in a browser. Inspect the current
  page's ring buffer with `window.__agentport.logs()`.
```

## Verification

- `npm run typecheck` — passed.
- `npx tsc -p site/tsconfig.json` — passed.
- `npx tsc -p site/tsconfig.worker.json` — passed.
- `npm run typecheck --workspace @agentport/extension` — passed.
- `npx tsc -p packages/cli/tsconfig.json` — passed (the CLI package is outside the root project references).
- `git diff --check` — passed.
- `node --import tsx scripts/log-check.ts` — passed: `logger check: 10 checks passed`.
- `node --import tsx packages/extension/build.ts` — passed; all five extension bundles, including `dist/sw.js`, were produced.

The exact requested `npx tsx scripts/log-check.ts` and npm extension-build commands could not start in this sandbox: the tsx CLI attempts to create an IPC pipe and receives `listen EPERM`. The IPC-free `node --import tsx` invocation uses the same tsx loader and passed for both the check and extension build.

`npm run e2e` is likewise stopped first by the tsx IPC restriction. The IPC-free equivalent reaches the actual test and then receives `listen EPERM` when binding `127.0.0.1`, so socket e2e could not be verified here. It must be run by the parent in an environment that permits loopback listeners.

## Risks and judgement calls

- The in-memory ring is module-global so logs from every shared protocol consumer appear in one DevTools view. Its default bound is 200; an explicit `bufferSize` updates that process/page-wide bound, and returned entries are shallow snapshots so callers/sinks cannot mutate the stored records directly.
- `recentLogs(level)` uses threshold semantics (`warn` returns warnings and errors), matching the logger's severity ordering rather than exact-level matching.
- An explicit sink replaces console output but never bypasses the ring. This preserves host/test capture without retaining the deleted string-callback path.
- CLI `console.log` calls that draw prompts, codes, consent text, and usage help remain direct user-interface output. Diagnostics and failures use the logger.
- Expected cancellation is surfaced in the modal/panel but not emitted as an error log; non-cancellation failures are both logged and shown.
- The extension uses callback-form Chrome APIs where that is the reliable way to inspect `chrome.runtime.lastError`; Promise-returning fire-and-forget APIs go through a single logging observer.
- Logging remains zero-dependency. The pino, debug, and OpenTelemetry links in `log.ts` document API/data-model prior art only.
