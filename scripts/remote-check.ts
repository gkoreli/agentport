// Keep the repository command and the packed release smoke on one
// implementation. `packages/cli/build.ts#buildRemoteCheck` bundles this exact
// module into the npm tarball used after deployment.
await import('../packages/cli/src/remote-check.js');

export {};
