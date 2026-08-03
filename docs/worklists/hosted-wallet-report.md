# Hosted wallet implementation report

Date: 2026-08-02  
Base: `44d5dbe` (`release: v0.0.2`, stateless-relay baseline)  
Commit ownership: no commit created

## Design conformance

1. **Protocol.** Added `SessionDelegation { delegate, agent, origin, expiresAt, sig }` and optional `SessionOpen.delegation`. The root user public key is deliberately absent. `delegationBody` signs `agentport-session-delegation:` plus canonical JSON of exactly `{ delegate, agent, origin, expiresAt }`; `verifyDelegation(expectedSigner, delegation)` requires the verifier's authoritative owner key instead of trusting a key carried by the statement. The helpers are exported through the existing protocol barrel.

2. **Relay.** `RelayCore.#openSession` accepts either direct ownership (`cert.user === authenticated client`) or the complete delegated chain: signature valid under the live target connection's `cert.user`, exact authenticated delegate key, exact target agent key, and live expiry. It cannot authenticate a browser origin, so it forwards the signed origin for the daemon to judge. It stores none of this. `RelayOptions.now` is a test-only clock seam used to prove that the daemon does not trust a relay's expiry judgment.

3. **Daemon.** `AgentDaemon.#onSessionOpen` independently verifies the signature under its own `identity.cert.user`, relay-stamped client/delegate equality, local identity/delegation agent equality, signed origin/`frame.surface.origin` equality, and expiry; failures return `bad_delegation`. Delegated session state is retained across resume. Both explicit runtime approvals and `requiresApproval` tool gates route to the client for delegated sessions; only `viaConnect` uses `onLocalApproval`. The decision comments document why popup authorization replaces the terminal connection gate. Delegated `session.opened` and `session.resumed` frames use `Personal agent`, keeping the daemon's real name out of page traffic.

4. **Client.** `AgentWallet.openSession` accepts an optional delegation and includes it in `session.open`. No alternate session-opening implementation was added.

5. **Wallet origin app.** Added an assets-only Worker config and a separate `wallet/` build. The app silently creates a plaintext-v1 root key on first load, persists verified certs in its own origin's localStorage, merges them with live `agents.list` presence, pairs through `claimPairing`/`approvePairing`, renders real names only in the popup, shows origin/tools/gated markers, and signs an eight-hour delegation scoped to the page key, selected agent, and browser-verified requester origin. The postMessage boundary binds only from `MessageEvent.origin` and the exact opener source, rebuilds hostile payload data, ignores all other sources/origins after binding, and always replies with the bound exact `targetOrigin`. No payload-claimed origin reaches the signed body. The storage header names the passkey-wrap upgrade.

6. **Connect ladder.** `AgentPort.connect()` now selects: installed `navigator.agent`; hosted wallet popup (production default `https://agentport-wallet.gogakoreli.workers.dev/connect`, `data-wallet` override, local default on port 8790); then the unchanged code modal when the popup is blocked, closed, or does not acknowledge within 20 seconds. A temporary `about:blank` popup preserves user activation during late extension discovery and is closed if the extension appears. The page key is fresh; the returned delegation is checked for exact delegate, selected agent, current origin, live expiry, signature shape, and absence of a `user` field before the page opens its own sealed `AgentWallet` session. The page cannot verify the owner signature because the owner key intentionally never crosses this boundary; relay and daemon do so from their certs. Existing `{agent, token}` resume records remain the authority used after reload.

7. **Panel approvals.** `AgentConnectRequest` now carries an optional page decider. The site panel supplies it on connect and resume, queues concurrent approval prompts, displays summary/tool/JSON arguments, and resolves Allow/Deny explicitly. Outstanding prompts fail closed when the session closes. The extension still strips page callbacks at its boundary and uses its own chrome decider, so its behavior is unchanged.

8. **Deploy.** The release script builds both site and wallet with the same root version, deploys the main Worker, then deploys `wrangler.wallet.toml`. The wallet worker has only static assets and SPA fallback; it has no relay route or Durable Object binding.

9. **Tests.** Section 13 of `scripts/e2e.ts` covers delegated success, a page payload with no root user key, generic page name, client-side approvals with `onLocalApproval` staying untouched, expired and wrong-delegate relay refusals, replay toward a second live owned agent, daemon refusal of a signed-origin mismatch, and an independent daemon expiry refusal through a real-socket relay with a deliberately dishonest clock. `scripts/wallet-popup-check.ts` checks origin binding, payload-origin rejection, post-bind source/origin rejection, idempotent retries, and exact reply target origins. `scripts/ui-smoke.ts` now covers the popup-blocked ladder plus rendered Allow behavior and emitted `approval.response`.

## Files changed

- `.gitignore` — ignores generated wallet entry HTML and bundle.
- `package.json` — adds wallet build and popup-check scripts.
- `packages/protocol/src/messages.ts` — delegation wire type and `SessionOpen` field.
- `packages/protocol/src/crypto.ts` — canonical delegation signing and safe verification helpers.
- `packages/relay/src/core.ts` — live delegated ownership chain.
- `packages/relay/src/relay.ts` — clock seam used by the hostile-relay edge test.
- `packages/daemon/src/daemon.ts` — edge re-verification, approval routing, delegated-name redaction, resume state.
- `packages/client/src/wallet.ts` — optional delegation on `openSession`.
- `packages/client/src/provider.ts` — page approval decider contract.
- `wallet/wallet.html` — wallet app document source.
- `wallet/src/app.ts` — pairing, picker/presence, consent, delegation, and popup UI.
- `wallet/src/handshake.ts` — hostile-boundary validation and exact-origin postMessage binding.
- `wallet/src/storage.ts` — plaintext-v1 identity and verified cert persistence.
- `wallet/public/styles.css` — wallet-origin presentation.
- `wallet/build.ts`, `wallet/tsconfig.json` — versioned bundle/static-entry build and strict browser typecheck.
- `wrangler.wallet.toml` — assets-only `agentport-wallet` Worker.
- `site/src/connect.ts` — extension/hosted/code ladder and delegated page session.
- `site/src/agentport-ui.ts`, `site/public/styles.css` — panel approval queue/cards.
- `site/public/index.html` — accurate hosted-wallet and fallback explanation.
- `scripts/deploy.ts` — wallet build/deploy after the main Worker.
- `scripts/e2e.ts` — delegated real-socket section 13.
- `scripts/wallet-popup-check.ts` — happy-dom postMessage trust checks.
- `scripts/ui-smoke.ts` — fallback and page approval behavior.
- `docs/worklists/hosted-wallet-report.md` — this report.

The forbidden surfaces were not changed: `packages/extension`, `site/src/inkwell.ts`, and `site/src/nisli-ui` remain untouched.

## Verification performed

Passed:

```text
npm run typecheck
npx tsc -p site/tsconfig.json
npx tsc -p site/tsconfig.worker.json
npx tsc -p wallet/tsconfig.json
npx tsc -p packages/extension/tsconfig.json
npx tsc -p examples/inkwell/tsconfig.json
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --skipLibCheck --types node scripts/e2e.ts
node --import tsx scripts/wallet-popup-check.ts
node --import tsx scripts/ui-smoke.ts
node --import tsx site/build.ts
node --import tsx wallet/build.ts
git diff --check
```

The popup check passed seven trust assertions. UI smoke passed the existing modal/panel/connect/message checks and the new approval-card/response checks. Both production bundles completed.

## Exact manual test: two browsers

Use a normal development machine where loopback listeners and browser windows are available.

1. Install/build everything:

   ```bash
   npm install
   npm run site:build
   npm run wallet:build
   npm run build:extension
   ```

2. Start the main local Worker (static demo plus relay) and wallet assets on separate origins:

   ```bash
   npx wrangler dev -c wrangler.toml --port 8787
   ```

   ```bash
   npx wrangler dev -c wrangler.wallet.toml --port 8790
   ```

3. Start two demo agents so the extension and hosted wallet can own separate certs without rebinding one device identity:

   ```bash
   AGENTPORT_RELAY=ws://127.0.0.1:8787/relay \
   AGENTPORT_IDENTITY=/tmp/agentport-extension-agent.json \
   AGENTPORT_RUNTIME=demo-writer \
   AGENTPORT_NAME="Extension test agent" \
   npm run daemon
   ```

   ```bash
   AGENTPORT_RELAY=ws://127.0.0.1:8787/relay \
   AGENTPORT_IDENTITY=/tmp/agentport-hosted-agent.json \
   AGENTPORT_RUNTIME=demo-writer \
   AGENTPORT_NAME="Hosted wallet test agent" \
   AGENTPORT_WALLET=http://127.0.0.1:8790/connect \
   npm run daemon
   ```

4. **Browser/profile A, extension installed.** Load unpacked `packages/extension/dist`, set its relay to `ws://127.0.0.1:8787/relay`, pair the extension agent's code, then open `http://127.0.0.1:8787/inkwell` and click Connect. Confirm no hosted popup remains, picker/connection consent appear in extension chrome, and a write prompt is approved in extension chrome rather than an in-page approval card. Reload and confirm extension resume still works.

5. **Browser/profile B, no extension.** Open the same Inkwell URL and click Connect. Confirm `http://127.0.0.1:8790/connect` opens, shows the exact requester origin, and starts in Pair. Paste the hosted agent's code, verify its real name/runtime only in the popup, pair, select the live agent (green dot), and confirm gated tools are marked. Approve. Back on Inkwell, confirm the panel says `Personal agent`; prompt `Add a line`, inspect summary and JSON arguments in the panel card, test Deny, prompt again, then test Allow. Reload and confirm the conversation resumes. Open `/tasker`, connect again, and confirm the popup remembers the agent without another pairing.

6. **Fallback tier.** In profile B, block popups (or close the wallet popup before approving) and click Connect again. Confirm the original code modal appears. Paste its code into the running hosted-agent terminal, approve the surface there, and confirm the session connects. For a gated action, confirm the daemon's local approval remains mandatory.

7. In DevTools, inspect the Inkwell origin's localStorage: it must contain no wallet root key or cert list. Inspect the wallet origin's localStorage: `agentport.wallet.identity.v1` and `agentport.wallet.certs.v1` live only there. The site origin may contain only its per-tab resume record in sessionStorage.

## Not verified here

- `node --import tsx scripts/e2e.ts` reached the first `listen(127.0.0.1)` and was rejected by the sandbox with `EPERM`; no real-socket e2e assertion, including section 13, executed in this environment. The file passed standalone strict compilation.
- Direct `npx tsx ...` commands were rejected before script load because tsx tried to create a local IPC listener under the sandbox temp directory. The same popup/UI/build files passed with `node --import tsx`, which uses the same tsx loader without that listener.
- No live browser, local Wrangler server, Cloudflare deployment, Durable Object, or production hosted-wallet origin was exercised here. `wrangler.wallet.toml` therefore still needs the manual/deployment smoke above.
- `scripts/deploy.ts` was not run because it bumps versions, deploys externally, and commits; this task explicitly leaves commit/deployment ownership to the parent.

## Risks and divergence audit

1. **The accepted page-visible floor is the selected agent pubkey and delegation signature.** The root user pubkey is no longer in `SessionDelegation` or the popup result, and an Ed25519 signature does not reveal its signing public key. The page still learns the stable selected agent pubkey because it must address that live agent through the relay; this can correlate origins that choose the same agent. It also learns the delegation signature because it must present the proof, but the signature is over a fresh delegate plus agent, origin, and expiry and does not disclose the root key. Removing the agent routing key would require a relay-addressing indirection outside this design. This is the accepted privacy floor.

2. **Origin judgment is necessarily split.** The relay verifies the owner signature, delegate, selected agent, and expiry, but cannot authenticate a browser's claimed surface origin. The daemon therefore performs the load-bearing equality check between the signed origin and forwarded `frame.surface.origin`. Section 13 locks this edge check down with an origin-replay refusal.

3. **Relay/daemon checks are intentionally duplicated and can diverge.** Both verify under their authoritative cert owner key and check delegate, selected agent, and expiry; the daemon additionally checks origin. They use independent clocks, so clock skew can make the relay accept and daemon deny (safe) or the relay deny before the daemon can judge. Also, the relay's direct-owner OR branch accepts a direct owner even if it attached a bad delegation, while the daemon follows the fixed `if frame.delegation` rule and returns `bad_delegation`. Keep section 13 and both predicates aligned if fields change.

4. **Hosted approvals are page-rendered by design.** Unlike extension chrome, the panel can be imitated or clickjacked by the site that owns it. The wallet popup authorizes the surface first, but the subsequent Allow/Deny pixels are not an out-of-page trust anchor. The daemon still enforces grant membership/expiry; this is a consent-UI risk, not a grant bypass.

5. **Plaintext root key at rest is explicitly v1.** Origin isolation prevents other sites reading it, but an XSS or supply-chain compromise on the wallet origin can. Passkey wrapping remains required before treating this tier as hardened custody.

6. **Relay selection is fixed for this tier.** Production wallet uses the deployed relay; localhost uses port 8787. Cert storage does not yet carry relay metadata, matching the repository's still-pending multi-relay work.

7. **The popup retains `window.opener`.** It is required for source-bound postMessage without wildcard discovery, but a compromised trusted wallet origin could navigate the opener. All application messages still require exact source/origin/id matching.
