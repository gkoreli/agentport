# Release and deployment

AgentPort has several artifacts but one hard wire release boundary:

- the Cloudflare Worker serves the site, `connect.js`, and `/relay`;
- the separate wallet Worker serves the hosted consent application;
- `@gkoreli/agentport` is the daemon CLI users run;
- the extension is another browser endpoint when distributed manually.

The relay and every endpoint that changed wire shape or required security
semantics cut over together. There is no compatibility window or fallback.
`packages/protocol/src/messages.ts#PROTOCOL_VERSION` makes a mismatch fail
visibly during `hello`; `relay speaks agentport/N` means the release was only
partially shipped.

## The release workflow

`.github/workflows/auto-tag.yml` watches every source that contributes to the
hosted Worker, relay, wallet, or browser bundle. On a matching push to `main`,
it:

1. installs from the lockfile and runs type, wire, and end-to-end checks;
2. runs the separately excluded site, Worker, wallet, extension, and example
   typechecks plus their browser-boundary harnesses, then builds the site and
   wallet artifacts before any tag can be created;
3. builds the self-contained CLI and keeps that exact tarball as an artifact;
4. refuses a change under `packages/cli`, `packages/daemon`, or
   `packages/protocol` when that CLI version already has a tag;
5. creates an annotated `vX.Y.Z` tag when the CLI version is new;
6. deploys the matching Worker, relay, and hosted wallet to Cloudflare unless
   the protected environment certifies that this exact commit was already
   deployed manually;
7. runs `npm run deployed:check` against the deployment it just made — the
   served `connect.js` must be this build byte for byte, and `/pair` must still
   name the extension-free wallet route;
8. extracts the saved npm tarball and runs its bundled, deadline-bounded remote
   pairing and prompt while an old Durable Object instance drains;
9. only after that exact-artifact smoke passes, publishes the saved tarball to npm
   through OIDC trusted publishing with provenance.

Hosted-only changes deploy without minting an npm version. If a push contains a
change to the CLI or either of its in-repository daemon/protocol inputs, it must
also contain a new CLI version; otherwise the workflow stops before deployment.
Npm publication is held behind the deploy-stage verification. A manual dispatch
with `deploy: true` redeploys the existing tag before the exact-artifact smoke.
With `deploy: false`, it deliberately leaves Cloudflare unchanged but still
downloads the saved tarball and proves the already-deployed production relay
matches it before retrying npm. It is not an unchecked publish shortcut.
Publishing an already present npm version is an idempotent success.

Wrangler is pinned exactly at `4.120.0` in the root package and lockfile. Keep
that exact pin: the deploy executable is part of the release input, not an
ambient latest-version dependency.

The real unpacked-extension gate similarly installs Chrome for Testing
`151.0.7922.76` through a commit-pinned setup action. Do not replace it with
the runner's branded Google Chrome: official Chrome removed command-line
unpacked-extension loading in version 137, so the browser runs while silently
loading no test subject. The Ubuntu 24 Actions job explicitly disables the
Chrome sandbox because that ephemeral runner's AppArmor policy disables the
unprivileged user namespaces CfT needs; the harness keeps the sandbox for every
ordinary local run.

The production job requires a protected GitHub `production` environment with:

- secret `CLOUDFLARE_API_TOKEN` — a narrowly scoped Cloudflare token with
  Workers edit access;
- variable `CLOUDFLARE_ACCOUNT_ID` — the owning Cloudflare account ID.
- variable `CLOUDFLARE_DEPLOYED_COMMIT` — the full commit SHA of an exact
  manual deployment, set only after its production smoke passes.

## Why every release so far was manual

Worth stating plainly, because the answer is not "the process requires it".
The workflow above has always been able to deploy on its own. The protected
`production` environment had `CLOUDFLARE_ACCOUNT_ID` and **no
`CLOUDFLARE_API_TOKEN`**, so the deploy step could never authenticate — and
it failed inside Wrangler's own credential flow, several minutes in, saying
nothing about this repository's configuration. The manual path below is what
that missing secret produced, not a policy.

Set the secret once and pushes to `main` deploy themselves:

```bash
gh secret set CLOUDFLARE_API_TOKEN --env production
```

Use a **dedicated** Cloudflare API token created from the *Edit Cloudflare
Workers* template — never the local Wrangler OAuth session, which is
interactive and expires. `scripts/deploy.ts` now refuses a CI deploy with the
secret unset and names it, so this cannot silently recur.

One companion setting matters: `CLOUDFLARE_DEPLOYED_COMMIT` SUPPRESSES the
automatic deploy for the exact commit it names. It exists so a manual
deployment is not redundantly repeated, and it should be set only immediately
after one. Left pointing at a stale commit it is inert; left pointing at the
commit you are about to push, it silently skips the deploy and publishes
against whatever is already live.

## Manual Cloudflare deployment

Still the right path when you are deliberately deploying by hand — a wire
cutover you want to watch, or a token you have not yet issued.

The repository's single deployment entry point is:

```bash
npm run deploy
```

`scripts/deploy.ts` bumps the root site version, builds the main site and
wallet, deploys both Workers with Wrangler, and commits the root version bump.
Wrangler must already be authenticated to the intended Cloudflare account.

**The next release is a coordinated v7 cutover.** `main` speaks `agentport/7`
(denial vocabulary enum, redacted runtime, prompt content blocks, live grant
updates) while the deployed relay still speaks `agentport/6` — so until that
release, `scripts/remote-check.ts` and any other probe of the DEPLOYED relay
is EXPECTED to be refused at `hello` with a version mismatch. That refusal is
the version gate doing its job, not a regression; no local gate depends on
the deployed protocol version. Ship relay, site bundle, hosted wallet,
extension build, and CLI together, per the order below — there is no v6
fallback anywhere in the tree.

For a wire-changing release, use this order:

1. Commit the implementation and CLI version bump locally, but do not push.
2. Run every release gate.
3. Run `npm run deploy`; this deploys the matching relay, browser bundle, and
   hosted wallet, then creates the root-version commit.
4. Run `npx tsx scripts/remote-check.ts` against the deployed relay, then
   `npm run deployed:check` — it exits non-zero until the deployment carries
   this build, which is the whole point of running it here.
5. Certify the successful manual deployment without copying the expiring
   Wrangler credential into GitHub:

   ```bash
   gh variable set --env production CLOUDFLARE_DEPLOYED_COMMIT \
     --body "$(git rev-parse HEAD)"
   ```

6. Push the local commits together. The CLI-version change triggers the
   release workflow, which rebuilds the exact npm tarball, proves it against
   the deployment from step 3, and only then publishes it. The matching
   protected-environment marker prevents a redundant Cloudflare deployment;
   any different commit must deploy through CI and therefore requires its
   dedicated token.
7. From a clean directory outside the monorepo, run the published CLI and
   confirm it connects to the hosted relay.

Running `npx @gkoreli/agentport` inside this monorepo may resolve the local
workspace package. A release smoke test must use a clean directory or an
explicit downloaded package so it actually tests npm.

## Cloudflare authentication

Cloudflare supports deploying Workers from GitHub Actions. Configure these
repository secrets:

- `CLOUDFLARE_API_TOKEN` — a narrowly scoped token allowed to edit the two
  Workers and their Durable Object deployment;
- `CLOUDFLARE_ACCOUNT_ID` — the owning Cloudflare account.

Cloudflare's official setup is documented in
[GitHub Actions for Workers](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).

On a push, CI calls `npm run deploy:ci` unless
`CLOUDFLARE_DEPLOYED_COMMIT` equals that push's full commit SHA. An explicit
`workflow_dispatch` with `deploy: true` also calls it. The command enters the
same `scripts/deploy.ts` build-and-deploy body as `npm run deploy` without
bumping a version or creating a commit from a runner. It stamps the root
version plus the short commit ID into both browser artifacts, so the panel
still identifies the exact deployed source. A matching manual-deployment
marker avoids the redundant mutation but not the release proof:
`packages/cli/build.ts#buildRemoteCheck` puts the production smoke into the npm
tarball and the deploy-stage job extracts and runs that copy before npm. A
missing or mismatched deployment therefore blocks publication.

The local Wrangler OAuth session is interactive and expiring; do not copy it
to GitHub. Create a dedicated API token in Cloudflare and store it only in the
protected environment. A failed deploy-stage remote smoke prevents npm
publication. A failed npm publication can be retried from the existing tag
through `workflow_dispatch`: set `deploy: false` only when production is
already the intended release, so the retry verifies that deployment before
publishing.
