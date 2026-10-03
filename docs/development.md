# Development constraints

Read the section relevant to a testing or tooling change. Setup commands are in
[README.md](../README.md#run-it); global rules are in [AGENTS.md](../AGENTS.md).

## Testing

`npm run verify` runs lint, format check, build and tests. It must pass with
Docker stopped. Use `packages/db/test/fake-db.ts` for ordinary store tests;
`make migrate` checks whether migrations actually apply.

Tests for rules enforced by SQL use real Postgres and skip when it is unavailable.
These include `email-single-owner.test.ts` (migrations 0007–0011),
`handle-registry.test.ts` (0029–0030) and `github-pointer.test.ts` (0034–0038).
They create and drop their own fixed-name scratch databases; the handle and
GitHub suites refuse non-local servers outside CI. Integration coverage for
analysis and bounty concurrency also uses dedicated fixtures. CI supplies
Postgres and SeaweedFS and checks that required integration coverage ran; see
[ci.md](./ci.md#ci-ciyml). Add service-dependent tests only for behavior a fake
cannot verify, preserving the service-free local verification path.

- Node tests run compiled `dist-test/` output via `tsconfig.test.json`; do not
  introduce a runner that executes TypeScript directly.
- Coverage thresholds live in workspace scripts: 90% for packages, 80% for API
  and worker. Preserve the thresholds and `--test-coverage-include="dist-test/src/**"`.
  A relative exclude alone misses the intended scope across workspace depths.
- `assert-all-covered` catches files no test imports. Add a test when it fails;
  exclude a compiled file in the workspace test script only if it cannot load
  in a test. Never put the test command on the left of a pipe: npm scripts
  do not enable `pipefail`, so failures can be hidden.
- Web uses Vitest and Testing Library with fakes at the fetch/auth-client boundary.
  Confirm a UI regression test fails before the fix.
- Extension tests use `node:test` with a fake `Host`. Keep logic in `commands.ts`,
  `task.ts` and `origin.ts`; only `extension.ts` imports `vscode`. That entry point,
  `build.js` and type-only `host.js` are excluded from coverage.

## Build and development servers

Make targets must work from a fresh clone: host targets use the `node_modules`
stamp, extension targets also use `ext-deps`. Delegate build/test logic to npm
scripts so Make and CI execute the same implementation.

The API runs compiled output. Keep its initial `tsc` followed by `;`, then
`tsc --watch` and `node --watch --watch-path=dist dist/server.js`. A compile
error can remove the output file: watching the directory and starting the
watchers after that error allow the server to recover on the next edit.
Do not replace this with TypeScript stripping or a file-only watch.

The extension has no server process and does not belong in compose. Its dev
loop requires both esbuild watch and `debug.extensionHost.autoReload`.

Build provenance rules live in [versioning.md](./versioning.md#how-it-is-wired).
Keep build arguments declared in every Docker stage that uses them; arguments
do not cross stages. Empty values count as absent to the resolver.

## Container dependencies

`api-dev`, `web-dev` and `worker` each run `npm ci` for the entire workspace.
Each must shadow **every** workspace's `node_modules` with an anonymous volume,
including new workspaces, so Linux dependencies cannot overwrite host binaries.
If the host tree is damaged, run `npm ci` on the host. App Dockerfiles build
from the repository root to include workspace packages.

`make up` compares `package-lock.json` with `.docker-deps-stamp` and recreates
the three dev containers when the lockfile is newer. `make relink` forces the
same repair when volumes are stale for another reason. Plain compose restarts
reuse the volumes and may leave dependencies stale.

Do not repair dependencies with `docker compose down -v`: Postgres and SeaweedFS
have no profile restriction, so that also deletes persistent data. The targeted
recreation used by Make preserves those services' volumes.
