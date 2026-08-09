# Release and deployment

AgentPort has several artifacts but one wire compatibility boundary:

- the Cloudflare Worker serves the site, `connect.js`, and `/relay`;
- the separate wallet Worker serves the hosted consent application;
- `@gkoreli/agentport` is the daemon CLI users run;
- the extension is another browser endpoint when distributed manually.

The relay and every endpoint that changed wire shape or required security
semantics must deploy together.
`packages/protocol/src/messages.ts#PROTOCOL_VERSION` makes a mismatch fail
visibly during `hello`; `relay speaks agentport/N` means the release was only
partially shipped.

## The release workflow

`.github/workflows/auto-tag.yml` watches every source that contributes to the
hosted Worker, relay, wallet, or browser bundle. On a matching push to `main`,
it:

1. installs from the lockfile and runs type, wire, and end-to-end checks;
2. runs the separately excluded site, Worker, wallet, extension, and example
   typechecks plus their browser-boundary harnesses;
3. builds the self-contained CLI and keeps that exact tarball as an artifact;
4. refuses a change under `packages/cli`, `packages/daemon`, or
   `packages/protocol` when that CLI version already has a tag;
5. creates an annotated `vX.Y.Z` tag when the CLI version is new;
6. deploys the matching Worker, relay, and hosted wallet to Cloudflare;
7. extracts the saved npm tarball and runs its bundled, deadline-bounded remote
   pairing and prompt while an old Durable Object instance drains;
8. only after that exact-artifact smoke passes, publishes the saved tarball to npm
   through OIDC trusted publishing with provenance.

Hosted-only changes deploy without minting an npm version. If a push contains a
change to the CLI or either of its in-repository daemon/protocol inputs, it must
also contain a new CLI version; otherwise the workflow stops before deployment.
Npm publication is held behind the same deployment. A manual dispatch may
redeploy or retry an existing tag, and publishing an already present npm
version is an idempotent success.

The production job requires a protected GitHub `production` environment with:

- secret `CLOUDFLARE_API_TOKEN` — a narrowly scoped Cloudflare token with
  Workers edit access;
- variable `CLOUDFLARE_ACCOUNT_ID` — the owning Cloudflare account ID.

## Current manual Cloudflare deployment

The repository's single deployment entry point is:

```bash
npm run deploy
```

`scripts/deploy.ts` bumps the root site version, builds the main site and
wallet, deploys both Workers with Wrangler, and commits the root version bump.
Wrangler must already be authenticated to the intended Cloudflare account.

For a wire-changing release, use this order:

1. Commit the implementation and CLI version bump locally, but do not push.
2. Run every release gate.
3. Run `npm run deploy`; this deploys the matching relay, browser bundle, and
   hosted wallet, then creates the root-version commit.
4. Run `npx tsx scripts/remote-check.ts` against the deployed relay.
5. Push the local commits together. The CLI-version change then triggers npm
   publication only after Cloudflare is already compatible.
6. From a clean directory outside the monorepo, run the published CLI and
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

The workflow calls `npm run deploy:ci`, which enters the same
`scripts/deploy.ts` build-and-deploy body as `npm run deploy` without bumping a
version or creating a commit from a runner. It stamps the root version plus the
short commit ID into both browser artifacts, so the panel still identifies the
exact deployed source. `packages/cli/build.ts#buildRemoteCheck` puts the
production smoke into the npm tarball; the deploy job extracts and runs that
copy, so importing a newer daemon from the checkout cannot manufacture a green
result for an older package.

The local Wrangler OAuth session is interactive and expiring; do not copy it
to GitHub. Create a dedicated API token in Cloudflare and store it only in the
protected environment. A failed deploy or remote smoke prevents npm
publication. A failed npm publication can be retried from the existing tag
through `workflow_dispatch` without creating a new release.
