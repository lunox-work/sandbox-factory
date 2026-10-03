# AGENTS.md

## Start here

Read `CONVENTIONS.local.md` first when it exists. Open it by name: it is
gitignored and takes precedence where it overlaps these instructions.
Use [docs/README.md](./docs/README.md) to find the relevant feature and source;
read only the sections needed for the task. Product proposals are not evidence
that a feature is implemented.

The repository is `lunox-work/sandbox-factory`; `feversoul` is the maintainer's
personal account. Repository URLs take the organization.

## Setup and verification

Use Node matching `package.json` (`^22.12.0 || >=24`) and `npm ci` for setup.
Run `npm run verify` before declaring done: lint, format check, build and tests,
in CI's order. Never bypass a failing pre-push hook with `--no-verify`.
During iteration, use `npx turbo run lint test --filter=<workspace-name>`.
Workspace names and entry points are in the [index](./docs/README.md#workspaces).

Read [development.md](./docs/development.md) before changing tests, Makefile,
Docker or dev scripts. It preserves the setup and testing constraints.

## Architecture and access

- Apps never import each other; shared logic belongs in packages.
- `packages/core` owns domain rules and has zero dependencies.
- `packages/client` uses `fetch` only: no `node:*`, `vscode` or `@types/node`.
  Keep its `types: []`. Only `apps/extension` may import `vscode`.
- Auth table constants stay singular (`user`), column properties camelCase
  (`emailVerified`). Better Auth resolves names at runtime. Keep all seven
  tables in `authSchema`; see `packages/db/test/auth-schema.test.ts`.
- Handle validation lives in `packages/core/src/handle.ts`; do not duplicate
  its length or character rules in schemas, stores or forms.
- Organization routes take the owner from the path after `requireMembership`,
  never `session.activeOrganizationId` or a request body. Every owner-scoped
  store method takes the organization first and includes it in its `WHERE`.
  Another owner's resource and non-membership return 404, not 403.
- Store methods do not branch on `organization.kind`. Personal and team
  organizations share the path; `refusePersonal` in `apps/api/src/auth.ts`
  guards personal-organization deletion and membership changes.
- Email/password sign-in stays off. `createApp` without auth serves 503 under
  `/api/*`; `/api/v1` is session-guarded. Routes outside it need deliberate access
  rules. The API requires `DATABASE_URL`; in-memory stores are test doubles.
- Read the relevant [architecture](./docs/architecture.md) section before
  changing ownership, auth, tickets, integration credentials or sandbox flows.

## Implementation

- Extend `tooling/tsconfig`; do not copy compiler options. Use `import type`,
  preserve strictness and narrow possibly undefined values rather than using `!`.
  Follow the workspace's existing import extensions; see
  [TypeScript configuration](./docs/architecture.md#typescript-configuration).
- Test behavior changes in the same change. Keep the existing runners and
  coverage thresholds; see [testing](./docs/development.md#testing).
  `npm run verify` must remain usable with Docker stopped.
- Generate migrations with `npm run db:generate --workspace @sandbox-factory/db`;
  never hand-edit `packages/db/drizzle/`. `dist/` and `dist-test/` are generated.
- Read [versioning.md](./docs/versioning.md) before changing build provenance.
  Keep `scripts/build-info.mjs` as the sole resolver, its `.d.mts` types,
  web's `virtual:build-info`, Turbo's declared build env and both CI provenance
  checks. API `BUILD_*` values remain optional. Docker build args needed in two
  stages must be declared in both.
- Dev containers `api-dev`, `web-dev` and `worker` must each shadow every
  workspace's `node_modules`. `make up` refreshes them after lockfile changes;
  `make relink` is the manual repair. Never use `down -v` for dependency repair:
  it deletes database and object-storage volumes.
- Dependabot handles routine dependency bumps. Explain any added dependency
  and its workspace in the PR; keep core dependency-free.
- Keep secrets out of files committed to git and out of output. When editing
  `.env.example`, align `.env.development` and `.env.production` in the same task:
  matching line counts, key positions, comments, headers and blank lines.
  New keys get empty values and retain the example's commented/active state;
  preserve existing values and activation states. See `CONVENTIONS.local.md`.

## Shipping

Commit, push, open a PR, merge, tag or deploy only when the user requests it.
For authorized shipping, read [scripts/README.md](./scripts/README.md) and use
`./scripts/ship.sh --title "fix: ..." --yes`. Exit 0 means PR open, not merged
or deployed; report its URL without a local watcher. Refresh main before the
next change. Keep one logical change per `fix/...` or `feat/...` branch and fill
in the PR template.

- Ready same-repository PRs auto-merge on required checks, except Dependabot
  majors. CodeRabbit and unresolved review threads are advisory. Use a draft
  to hold a PR for inspection; policy changes follow the same pipeline.
- The Conventional Commit PR title becomes the squash commit and controls the
  release. Tags are the version of record; never hand-edit `CHANGELOG.md`.
  See [CI and releases](./docs/ci.md) for version rules and required check names.
- Read [ci.md](./docs/ci.md) before editing workflows. Never execute PR code in
  a privileged `pull_request_target` workflow or weaken permissions. Change
  required check names and branch protection together.
- Never automatically resolve review threads, dismiss reviews, post approval
  overrides, fabricate passing statuses or use admin bypass to ship.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
