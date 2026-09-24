# AGENTS.md

Instructions for coding agents. Humans: see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Workspaces

| Workspace          | Name                        | Published? |
| ------------------ | --------------------------- | ---------- |
| `packages/core`    | `sandbox-factory`           | not yet    |
| `packages/shared`  | `@sandbox-factory/shared`   | no         |
| `packages/db`      | `@sandbox-factory/db`       | no         |
| `packages/client`  | `@sandbox-factory/client`   | no         |
| `apps/api`         | `@sandbox-factory/api`      | no         |
| `apps/web`         | `@sandbox-factory/web`      | no         |
| `apps/extension`   | `sandbox-factory-vscode`    | no (vsce)  |
| `tooling/tsconfig` | `@sandbox-factory/tsconfig` | no         |

Dependency rules are in [docs/architecture.md](./docs/architecture.md). In short:

- `packages/core` has zero dependencies and owns the shared domain rules
  (public handles, which users and organizations draw from one namespace).
- `packages/client` is platform-neutral: `fetch` only, no `node:*`, no `vscode`.
- Only `apps/extension` may import `vscode`.
- Apps never import each other. Shared logic moves down into a package.

## Setup and verification

Node.js 22+. Install with `npm ci` (not `npm install`, which rewrites the lock
file).

```bash
npm run verify   # lint, format check, build, test — run before declaring done
```

`verify` is what CI and the `pre-push` hook run, and exists only at the root.
PRs auto-merge on green, so this is the gate, not a formality — never
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

**Read `CONVENTIONS.local.md` first when it exists.** It is gitignored, so it
is absent from a clean checkout and invisible to anything that only reads the
tracked tree — an agent that does not open it by name will not know its rules
exist. It holds conventions that cannot live here, and it takes precedence
where the two overlap.

### Auth and data access

- **`packages/db/src/schema.ts` auth table consts stay singular (`user`) and
  column properties stay camelCase (`emailVerified`).** Better Auth's Drizzle
  adapter resolves both by string at runtime, so a rename fails at sign-in, not
  at compile time. This covers the organization plugin's three tables
  (`organization`, `member`, `invitation`) as well as the four core ones; all
  seven are in `authSchema`, and `packages/db/test/auth-schema.test.ts` asserts
  the list and the naming.
- **Handle rules live in `packages/core/src/handle.ts`**, shared by usernames
  and organization slugs. Do not restate the length or character set anywhere
  else; the profile store, the plugin hooks, the zod schemas and both browser
  forms all call the same functions.
- **Organization-scoped routes take the id from the path, never from
  `session.activeOrganizationId`.** That value is a UI preference shared by
  every tab and by the extension's bearer session, and the session cookie cache
  makes it stale. `requireMembership` in `routes.ts` reads the `member` table;
  a non-member is a 404.
- **Every store method takes the owner as its first argument, in the `WHERE`
  clause.** The owner is an `organization_id`, whether the organization is a
  team or somebody's personal one — every user gets a personal organization at
  signup, which is why nothing needs a nullable user/organization pair. It
  comes from the path segment the membership guard has already checked, never
  from a request body. A session says who is asking, not what they may read.
  Another owner's id is a 404, never a 403.
- **No store method branches on `organization.kind`.** Personal and team
  organizations take the same path; only surfaces present them differently.
  The exceptions are the `refusePersonal` guards in `apps/api/src/auth.ts`,
  which stop a personal organization gaining members or being deleted.
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
  - **The exception: rules that live in SQL.** `email-single-owner.test.ts`
    (migrations 0007-0011) and `handle-registry.test.ts` (0029-0030) test
    triggers and indexes a fake cannot execute. Both skip when no Postgres is
    reachable, so `verify` still passes with Docker stopped, and CI runs them
    against its Postgres service. They create and drop only their own
    fixed-name scratch databases, and the handle suite refuses a non-local
    server outside CI. Add to this list only for SQL-enforced rules.
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

### Build provenance

Every surface reports the commit it was built from; see
[docs/versioning.md](./docs/versioning.md). Everything here fails **silently** —
a broken injection stamps the artifact `unknown` rather than breaking the build
— so the rules are about keeping the guards intact.

- **The web app gets its record from a `virtual:build-info` module, not
  `define`.** The dev server does not bundle, so `define` leaves an undeclared
  global there while the production build and the test suite stay green. Do not
  "simplify" it back. `apps/web/test/build-injection.test.ts` fails if you do.
- **`scripts/build-info.mjs` is the only resolver.** Four build sites read it;
  never inline a second copy.
- It stays plain JavaScript: it runs in a Vite config, an esbuild config and
  `node` in CI, all before anything compiles TypeScript.
  `scripts/build-info.d.mts` types it — **the `.d.mts` extension is
  load-bearing**; a `.d.ts` beside an `.mjs` is silently ignored.
- **Leave the `env` block on `build` in `turbo.json` alone.** Turbo's strict
  environment drops undeclared vars, and these are part of the cache key — or
  turbo replays a bundle stamped with the wrong commit.
- The release workflow runs `--require-identified` and CI greps the built bundle
  for the sha. The first proves the resolver saw a sha, the second that it
  reached the artifact. Keep both.
- **The API's `BUILD_*` vars are optional on purpose**, unlike `DATABASE_URL`.
  A missing sha is cosmetic; refusing to boot over it would be an outage.
- **The dev containers get their provenance from the Makefile, not from git.**
  `node:22-alpine` has no git binary, so the `BUILD_*` exports near `up:` are
  what make the version readout work under `make up`.
- A Dockerfile build arg must be declared in **both** the build and runtime
  stages — ARGs do not cross stages. An undeclared ARG is the empty string, not
  unset, which is why the resolver treats empty as absent.

### Build and tooling

- **Make targets must work from a fresh clone.** `make up` and `make ext` are
  what a new contributor types first. Host targets depend on a `node_modules`
  stamp; extension targets also depend on `ext-deps`.
- The `Makefile` delegates to npm scripts and never reimplements build or test
  logic. CI calls the npm scripts directly.
- Dev servers run compiled output. Do not replace `apps/api`'s `tsc --watch` +
  `node --watch dist/server.js` with `--experimental-strip-types`.
- **`apps/api`'s `dev` script watches `dist/`, not just `dist/server.js`, and
  the first `tsc` is followed by `;` rather than `&&`.** Both guard the same
  failure: a compile error empties `dist/`, `node --watch` dies with
  `MODULE_NOT_FOUND`, and it drops the watch on a _file_ that no longer exists
  — so fixing the error never revives it and every `/api/*` call 502s through
  Vite until someone restarts the container. `--watch-path=dist` watches the
  directory, which survives the file going away. The `;` keeps the watchers
  starting when the tree is already broken at `make up` time, instead of
  short-circuiting into a container that exits.
- The VS Code extension has no server process, so do not add it to compose. Its
  dev loop needs both halves: esbuild rebuilding on save, and
  `debug.extensionHost.autoReload`.
- Dev containers shadow `node_modules` with anonymous volumes (the host tree
  holds darwin binaries). Both Dockerfiles build from the repo root, because the
  apps import workspace packages from outside their directory.
- **Adding a dependency needs `make relink`, not `make up`.** The `npm ci` in
  `web-dev`/`api-dev`'s command installs into anonymous volumes that
  `docker compose up` reuses, so a package installed on the host never appears
  inside and Vite fails with `Failed to resolve import` however many times you
  restart. `relink` removes those two containers with their volumes so the next
  start repopulates them. Do not reach for `down -v`: `postgres` and
  `seaweedfs` declare no `profiles:`, so they belong to every profile and a
  profile-scoped `down -v` deletes the database and the object store too.
- `dist/` and `dist-test/` are gitignored build output.
- Do not hand-edit `packages/db/drizzle/` — drizzle-kit generates it via
  `npm run db:generate --workspace @sandbox-factory/db`.

### Shipping a change

**Use `./scripts/ship.sh --title "fix: ..." --yes`.** It verifies, pushes, opens
the PR and returns to local main. GitHub owns CI, CodeRabbit repairs, re-review
and auto-merge. See [scripts/README.md](./scripts/README.md).

- Exit 0 means PR open, not merged or deployed. Report its URL; no local watcher.
- Local main is refreshed on return, not after the eventual merge. Pull before
  starting the next change. GitHub deletes merged remote branches, not local ones.
- Never automatically resolve threads, dismiss reviews, post CodeRabbit approval
  overrides, fabricate passing statuses or use admin bypass to unblock shipping.
- Use a draft for changes that should not enter the automatic pipeline yet.

### Commits, PRs, and releases

The rules `ship.sh` encodes; [docs/ci.md](./docs/ci.md) has the detail.

- Branch off `main` as `fix/...` or `feat/...`. `main` takes squash merges only;
  you cannot push to it. One logical change per PR; fill in the template.
- **Ready PRs enter the automatic pipeline.** Same-repository PRs auto-merge
  (squash) once CI passes and CodeRabbit approves the current head, except
  Dependabot majors. Policy changes (workflows, scripts, infra) take the same
  path; there is no separate sign-off. Use a **draft** when a change should be
  held for inspection.
- **The PR title is the squash commit, and the squash commit decides the
  version.** `scripts/next-version.mjs`: `!`/`BREAKING CHANGE:` → major, `feat`
  → minor, `fix`/`perf`/`revert`/`build`/`refactor` → patch, anything else → no
  release. A PR titled `docs:` containing a `fix:` commit releases nothing,
  silently. Pinned by `packages/shared/test/next-version.test.ts`.
- **Every deploy that carries a releasable commit becomes a release.** `cd.yml`
  computes the version, builds, deploys, verifies the live site, and only then
  tags. A failed deploy cuts no release. A chore-only merge deploys without a
  version; a docs-only merge does not deploy at all (`paths-ignore`).
- **Tags are the version of record, not `package.json`**, which nothing bumps.
- **Unresolved review threads block the merge.** CodeRabbit must verify the
  fixes and approve the latest head; do not issue resolve/approve overrides.
- Required contexts: `Test (Node 22)`, `Test (Node 24)`, `Analyze`, `CodeQL`,
  `Review gate`. Renaming a required context blocks merging until protection is
  updated. See `.github/main-ruleset.json` and the rollout notes in `docs/ci.md`.
- Never hand-edit `CHANGELOG.md`.

### Do not

- **Edit `.github/workflows/*.yml` casually.** Several run on
  `pull_request_target`, with write permissions in the base branch's context.
  Never make one check out or execute PR code — that hands a fork the ability to
  merge to `main`. Read [docs/ci.md](./docs/ci.md) first.
- Weaken the `permissions:` blocks in workflows.
- Bump dependencies by hand; Dependabot does it weekly.
- Add a dependency without saying why, and which workspace, in the PR body.
  `packages/core` has zero runtime dependencies by design.
- Commit secrets. `.env.development` and `.env.production` are gitignored;
  `docker-compose.yml` credentials are local development values only.
- **Change `.env.example` without updating `.env.development` and
  `.env.production` in the same task.** Because both are gitignored, a missed
  update never shows in `git status` and never fails CI — it surfaces as a
  service that boots without the value. `.env.example` is the structural source
  of truth: all three keep the same line count, with every key on the same
  line and matching comments, headers, and blank lines. Add new keys with an
  **empty value** (`KEY=`), commented out (`# KEY=`) if the example comments
  them. Never copy an example default over a configured value, and never
  enable a key an environment deliberately leaves commented out. Check the
  line counts afterwards, and keep the values out of any output.
  `CONVENTIONS.local.md` states this rule in full.

## Two names

The repository is **`lunox-work/sandbox-factory`** — `lunox-work` is the owning
organization. **`feversoul`** is the maintainer's personal account: it appears in
`.github/CODEOWNERS`, `package.json`'s `author`, and the README copyright.
Repository URLs take the org.
