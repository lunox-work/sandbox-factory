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

Bounty concurrency checks run separately with
`npm run test:bounty-concurrency --workspace @sandbox-factory/db` and an explicit
`DATABASE_URL` for a disposable Postgres service. Unlike ordinary tests this
suite fails when Postgres is unavailable; CI runs it sequentially after `npm test`.
The same command runs `bounty-migration.integration.ts`, which checks the
hand-written backfills of migrations 0045 and 0046 on scratch databases. For
local S3 verification, set `TEST_S3_ENDPOINT` to a disposable SeaweedFS port;
never derive integration configuration from production environment files.

- Node tests run compiled `dist-test/` output via `tsconfig.test.json`; do not
  introduce a runner that executes TypeScript directly.
- Coverage thresholds live in workspace scripts: 90% for packages, 80% for API,
  worker and extension. Preserve the thresholds and `--test-coverage-include="dist-test/src/**"`.
  A relative exclude alone misses the intended scope across workspace depths.
- `assert-all-covered` catches files no test imports. Add a test when it fails;
  exclude a compiled file in the workspace test script only if it cannot load
  in a test. Never put the test command on the left of a pipe: npm scripts
  do not enable `pipefail`, so failures can be hidden.
- Web uses Vitest and Testing Library with fakes at the fetch/auth-client boundary.
  `apps/web/test/render.tsx` supplies an isolated query client per render/hook.
  Complete wire fixtures exercise response validation; cache ownership and
  non-overlapping observation regressions live in `server-data.test.tsx`.
  Confirm a UI regression test fails before the fix.
- Extension tests use `node:test` with a fake `Host`. Keep logic in `commands.ts`,
  `task.ts` and `origin.ts`; only `extension.ts` imports `vscode`. That entry point,
  `build.ts` and type-only `host.ts` are excluded from coverage.
- Core's `*-laws.test.ts` and `*-properties.test.ts` check what a rule
  promises of every input rather than of chosen examples: the pricing
  arithmetic and stage rules over their whole bounded domain, handles,
  aliases and the slice walk on generated inputs (`fast-check`), and the
  fixture expression gate against a real parser (`acorn`). Both are test
  dependencies of `packages/core` only; its `src` stays dependency-free.
  When a law test fails, the law or the code is wrong; fix the one that
  is, never the bound.
- The lease protocol, the worker's job limiter and its progress writer are
  modelled in TLA+ under [docs/specs](./specs/README.md); alias
  reversibility and the handle stem law are proved in Lean 4 under
  `docs/specs/lean`. CI's `Formal specs` job checks both; locally, re-run
  TLC or `lake build` by hand when the modelled code changes, since
  `npm run verify` stays free of Java and Lean.

## Import boundaries

`npm run lint:deps` runs dependency-cruiser over every `apps/*/src` and
`packages/*/src`. It parses with SWC because dependency-cruiser does not
support TypeScript 7; its "missing TypeScript transpiler" warning is expected.
`scripts/dependency-resolver.cjs` only teaches it the `@/` alias and workspace
entry points and does not affect builds. If `@swc/core` is missing the run
cruises almost nothing, so keep it pinned in the root `devDependencies`.

## Browser smoke tests

`npm run test:e2e` builds the API and web app, then runs Playwright
(`e2e/*.spec.mjs`, Chromium) against `e2e/server.mjs`: the built web bundle and
the compiled production Hono routes with in-memory session and store doubles.
It needs no Docker, database or credentials, and does not exercise Better Auth's
OAuth flow, PostgreSQL or third-party integrations. Run
`npx playwright install chromium` once. It is deliberately outside
`npm run verify`; CI runs it in [`e2e.yml`](../.github/workflows/e2e.yml) as a
required check.
Extend the doubles in `e2e/server.mjs` when a new flow needs a store; never add
a reset endpoint or auth bypass to the product for the suite.

## Maintenance tools for agents

Three optional agent skills live in `.agents/skills/`; `.claude/skills` is a
symlink to it so Codex and Claude Code find the same ones. The tools themselves
are not committed. Run `scripts/install-agent-tools.sh` once per clone to
install all three (or pass `archify`, `diagram-design` or `graphify`), and again
after a pin changes.
Their output is supplemental: reviewed rules and explanations stay in
`AGENTS.md` and `docs/`.

- **Graphify** (`scripts/graphify.sh`, skill `graphify`): a pinned, code-only
  graph for finding definitions, callers and cross-workspace paths. The venv and
  graph live in `~/.cache/sandbox-factory/graphify` (override with
  `GRAPHIFY_CACHE`); needs Python 3.10+. It is unrelated to the worker's
  Graphify adapter and its pin.
- **Archify** (skill `archify`): on-demand architecture diagrams. The install
  script unpacks `tt-a1i/archify` v3.0.1 at a pinned commit into the gitignored
  `.agents/skills/archify`; needs Node 18+ and `curl`. Check it with `node .agents/skills/archify/bin/archify.mjs doctor`. Write
  diagrams outside the checkout unless one is being committed on purpose. A
  validated diagram is not evidence the system behaves that way.
- **Diagram Design** (skill `diagram-design`): editorial HTML/SVG diagrams. The
  install script unpacks the skill directory of `cathrynlavery/diagram-design`
  2.6.68 at a pinned commit into the gitignored `.agents/skills/diagram-design`;
  needs `curl`. Its style guide is also the product's diagram skin:
  `packages/shared/src/diagram-skin.ts` holds its semantic roles, which the
  workbench draws every Graphviz and Mermaid diagram with. Change the roles there, not in either app.

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

For access from another device, extend `CORS_ORIGINS` with the web origins
(scheme, hostname and port) and set `VITE_DEV_ALLOWED_HOSTS` to comma-separated
hostnames in the gitignored `.env.development` used by `make up`. Better Auth
already trusts `CORS_ORIGINS` as well as its own `BETTER_AUTH_URL`; the web
client sends relative `/api` requests through Vite's proxy. For host-run Vite,
use `apps/web/.env.local`. A leading dot in an allowed hostname matches its
subdomains; prefer exact hostnames when only one device serves the app.
Defaults remain localhost-only. Allowing an origin does not change the OAuth
provider callback: `BETTER_AUTH_URL` must also be browser-reachable and match
the redirect URI registered with each provider. When using an HTTPS dev proxy,
set `BETTER_AUTH_URL`, `APP_URL` and `VITE_DEV_CANONICAL_ORIGIN` to its origin
locally. The optional Vite setting moves browser pages to that origin before
sign-in, preserving the path, query and fragment so OAuth state and session
cookies stay on one hostname. It applies only to the dev server; unset, it
adds no redirect. HEAD requests and API calls are unaffected.

## Container dependencies

`api-dev`, `web-dev` and `worker` each run `npm ci` for the entire workspace.
`api-dev` and `web-dev` must shadow **every** workspace's `node_modules` with an
anonymous volume, including new workspaces, so Linux dependencies cannot
overwrite host binaries. `worker` mounts the checkout read-only and installs
into its own copy (`docker-compose.yml`).
If the host tree is damaged, run `npm ci` on the host. App Dockerfiles build
from the repository root to include workspace packages.

`make up` compares `package-lock.json` with `.docker-deps-stamp` and recreates
the three dev containers when the lockfile is newer. `make relink` forces the
same repair when volumes are stale for another reason. Plain compose restarts
reuse the volumes and may leave dependencies stale.

Do not repair dependencies with `docker compose down -v`: Postgres and SeaweedFS
have no profile restriction, so that also deletes persistent data. The targeted
recreation used by Make preserves those services' volumes.
