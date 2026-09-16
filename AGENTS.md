# AGENTS.md

Instructions for coding agents. Humans: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Workspaces

| Workspace          | Name                        | Published? |
| ------------------ | --------------------------- | ---------- |
| `packages/core`    | `sandbox-factory`           | **yes**    |
| `packages/shared`  | `@sandbox-factory/shared`   | no         |
| `packages/db`      | `@sandbox-factory/db`       | no         |
| `packages/client`  | `@sandbox-factory/client`   | no         |
| `apps/api`         | `@sandbox-factory/api`      | no         |
| `apps/web`         | `@sandbox-factory/web`      | no         |
| `apps/extension`   | `sandbox-factory-vscode`    | no (vsce)  |
| `tooling/tsconfig` | `@sandbox-factory/tsconfig` | no         |

Dependency rules are in [docs/architecture.md](./docs/architecture.md). In short:

- `packages/core` has zero dependencies and owns the todo domain rules.
- `packages/client` is platform-neutral: `fetch` only, no `node:*`, no `vscode`.
- Only `apps/extension` may import `vscode`.
- Apps never import each other. Shared logic moves down into a package.

## Setup and verification

Node.js 22+. Install with `npm ci` (not `npm install`, which rewrites the lock
file).

```bash
npm run verify   # lint, format check, build, test — run before declaring done
```

`verify` is exactly what CI runs and what the `pre-push` hook runs. It exists
only at the root. Eligible PRs auto-merge on green (everything except a
Dependabot major), so this is the gate, not a formality — never
`git push --no-verify` past a failure.

To iterate on one workspace during development (never as the final check):

```bash
npx turbo run lint test --filter=@sandbox-factory/api
```

| Command                | What it does                              |
| ---------------------- | ----------------------------------------- |
| `npm run verify`       | All of the below, in CI's order           |
| `npm run lint`         | Type-check every workspace, no emit       |
| `npm run format:check` | Fail if anything is unformatted           |
| `npm run format`       | Fix formatting in place                   |
| `npm run build`        | Build every workspace in dependency order |
| `npm test`             | Test every workspace with coverage        |

## Rules

### Auth and data access

- **`packages/db/src/schema.ts` auth table consts stay singular (`user`) and
  column properties stay camelCase (`emailVerified`).** Better Auth's Drizzle
  adapter resolves both by string at runtime, so a rename fails at sign-in, not
  at compile time. `packages/db/test/auth-schema.test.ts` asserts both.
- **Every `TodoStore` method takes the owner as its first argument, in the
  `WHERE` clause.** The owner comes from `c.get("user").id`, never a request
  body. A session says who is asking, not what they may read — these routes once
  sat behind a session guard with no `user_id` column and served every user the
  whole table. Another user's id is a 404, never a 403.
- Email/password sign-in is deliberately off. `apps/api/test/auth.test.ts`
  asserts on the 400 response; do not enable the feature to make it pass.
- `createApp` without an `auth` option serves 503 on `/api/*`. Routes under
  `/api/v1` are behind the session guard; routes outside it are not.
- `apps/api` requires `DATABASE_URL` and has no in-memory fallback.
  `createInMemoryStore` is a test double, and enforces the same owner boundary.

### Tests

- **No test may depend on a running container.** `npm run verify` must pass with
  Docker stopped. Test `packages/db` against `packages/db/test/fake-db.ts`.
  Whether the SQL actually applies is verified with `make migrate`.
- Tests run against compiled output (`dist-test/`), not sources. Do not add a
  runner that executes TypeScript directly.
- Coverage thresholds are per workspace: 90% packages, 80% `apps/api`. New code
  needs tests in the same change. Do not lower a threshold to make a change
  pass.
- Leave `--test-coverage-include="dist-test/src/**"` alone — it scopes the
  report to the workspace's own source. It must be an include, not a relative
  exclude, because workspaces sit at different depths.
- `assert-all-covered` catches source files no test imports, which the coverage
  flags miss entirely. If it fails, add a test. Only if the file cannot be
  loaded by a test, add its compiled name as an argument in that workspace's
  `test` script.
- **Never put the test command on the left of a pipe.** npm runs scripts without
  `pipefail`, so a failing run would exit 0.
- `apps/web` uses Vitest with Testing Library, faking the server at the `fetch`
  and auth-client boundary. Check a UI test fails before the fix.
- `apps/extension` has a placeholder runner. Adding real logic there means
  adding a real runner in the same change.

### TypeScript

- Extend `tooling/tsconfig` (`base`, `node`, `react`, `extension`); never copy
  compiler options between packages.
- `verbatimModuleSyntax` is on: type-only imports must say `import type`.
- `strict` and `noUncheckedIndexedAccess` are on: indexing yields `T |
undefined`. Narrow it rather than using `!`.
- Import extensions differ by resolution mode, and both are correct. `NodeNext`
  (`core`, `shared`, `client`, `db`, `api`) writes `./store.js`; `Bundler`
  (`web`, `extension`) writes `./tree`. Moving a file between them means
  adjusting its imports.
- Do not add `@types/node` to `packages/client` — its `types: []` is what keeps
  `node:` imports out of the browser and extension bundles.

### Build and tooling

- **Make targets must work from a fresh clone.** `make up` and `make ext` are
  what a new contributor types first. Host targets depend on a `node_modules`
  stamp; extension targets also depend on `ext-deps`. Test in a clean clone.
- The `Makefile` delegates to npm scripts and never reimplements build or test
  logic. CI calls the npm scripts directly.
- Dev servers run compiled output. Do not replace `apps/api`'s `tsc --watch` +
  `node --watch dist/server.js` with `--experimental-strip-types`.
- The VS Code extension is not containerized — it has no server process. Do not
  add an extension service to compose. Its dev loop needs both halves: esbuild
  rebuilding on save, and `debug.extensionHost.autoReload`.
- Dev containers shadow `node_modules` with anonymous volumes (the host tree
  holds darwin binaries). Both Dockerfiles build from the repo root, because the
  apps import workspace packages from outside their directory.
- `dist/` and `dist-test/` are gitignored build output.
- Do not hand-edit `packages/db/drizzle/` — drizzle-kit generates it via
  `npm run db:generate --workspace @sandbox-factory/db`.

### Commits, PRs, and releases

**`./scripts/ship.sh --title "fix: ..." --yes` does all of this for you** —
branches off `main`, verifies, opens the PR, settles review threads and waits
for the merge. Prefer it over doing the steps by hand; see
[scripts/README.md](./scripts/README.md). The rules below are what it encodes.

- Branch off `main` as `fix/...` or `feat/...`. `main` takes squash merges only;
  you cannot push to it.
- **Unresolved review threads block the merge.** `main` also has a classic
  branch protection with `required_conversation_resolution` and
  `enforce_admins`, so a green PR with an open CodeRabbit thread will not land
  and `--admin` will not force it. Resolve threads with
  `gh pr comment <n> --body '@coderabbitai resolve'`.
- Conventional Commits drive the release: `fix:` patch, `feat:` minor,
  `!`/`BREAKING CHANGE:` major. `chore:`/`docs:`/`ci:` produce no release.
- **The PR title is the only commit message that survives the squash.** A PR
  titled `docs:` containing a `fix:` commit produces no release, silently. Title
  the PR for its user-facing change.
- Required checks: `Test (Node 22)`, `Test (Node 24)`, `Analyze`. Branch
  protection matches them **by job name** — renaming the job or changing the
  Node matrix values stops the ruleset requiring it, and auto-merge will then
  merge on checks that never ran. Update the ruleset in the same change.
- **Opening a PR is the last decision point.** Auto-merge arms on every PR
  except a Dependabot major, and nobody clicks anything. If you want a human to
  look first, open it as a **draft**.
- One logical change per PR. Fill in the template, link the issue.
- `CHANGELOG.md` is generated by release-please at `packages/core/CHANGELOG.md`.
  Never hand-edit it.
- release-please watches `packages/core` only. A new published package needs
  entries in `release-please-config.json` and `.release-please-manifest.json`,
  and must not be `"private": true`.

### Do not

- **Edit `.github/workflows/*.yml` casually.** Several run on
  `pull_request_target`, with write permissions in the base branch's context. In
  particular, never make one check out or execute PR code — that hands a fork
  the ability to merge to `main`. Read [docs/ci.md](./docs/ci.md) first.
- Weaken the `permissions:` blocks in workflows.
- Bump dependencies by hand; Dependabot does it weekly.
- Add a dependency without saying why, and which workspace, in the PR body.
  `packages/core` has zero runtime dependencies by design — adding one there
  needs to be raised.
- Commit secrets. `.env` is gitignored; `docker-compose.yml` credentials are
  local development values only.

## Two names

The repository is **`lunox-work/sandbox-factory`** — `lunox-work` is the owning
organization. **`feversoul`** is the maintainer's personal account: it appears in
`.github/CODEOWNERS`, `package.json`'s `author`, and the README copyright.
Repository URLs take the org.
