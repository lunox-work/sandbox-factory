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
  clause.** For `TodoStore` the owner is the user; for an organization-owned
  table it is the organization id. It comes from `c.get("user").id` or the path
  segment the membership guard has already checked, never from a request body.
  A session says who is asking, not what they may read. Another owner's id is a
  404, never a 403.
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
- `dist/` and `dist-test/` are gitignored build output.
- Do not hand-edit `packages/db/drizzle/` — drizzle-kit generates it via
  `npm run db:generate --workspace @sandbox-factory/db`.

### Shipping a change

**Use `./scripts/ship.sh --title "fix: ..." --yes`.** It branches off `main`,
verifies, opens the PR, settles review threads and waits for the merge. See
[scripts/README.md](./scripts/README.md).

- **When it prints the PR URL, you are done.** It returns 0 once the PR is
  _open_ and watches the merge from a detached child. Do not poll
  `gh pr checks`, `sleep` and re-check, or tail the log — a ship takes 10–15
  minutes, nearly all of it waiting on CodeRabbit. Report the URL and stop. If
  a later turn needs the outcome, check once:
  `gh pr view <n> --json state --jq .state`.
- **If `.git/ship/pr-<n>.review.md` exists for your last ship, read it before
  the next change** and fix what is real in a follow-up PR. ship.sh resolves
  CodeRabbit's threads unread, but saves them there first.
- **It leaves you on `main`; start the next change there.** Do not check out
  the branch you just shipped — that stacks work on an open PR, which `ship.sh`
  refuses (`has commits not in main`). A follow-up is a new branch off `main`.
- **Never `git checkout` or `git stash` while a ship is being watched.** The
  child shares your working tree.
- Use `--foreground` only when the merge is a precondition for work in the same
  turn, which is rare.

### Commits, PRs, and releases

The rules `ship.sh` encodes; [docs/ci.md](./docs/ci.md) has the detail.

- Branch off `main` as `fix/...` or `feat/...`. `main` takes squash merges only;
  you cannot push to it. One logical change per PR; fill in the template.
- **Opening a PR is the last decision point.** Auto-merge arms on every PR
  except a Dependabot major, and nobody clicks anything. If a human should look
  first, open it as a **draft**.
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
- **Unresolved review threads block the merge**, and `enforce_admins` means
  `--admin` will not force it. Resolve with
  `gh pr comment <n> --body '@coderabbitai resolve'`.
- Required checks — `Test (Node 22)`, `Test (Node 24)`, `Analyze` — are matched
  **by job name**. Renaming a job or changing the Node matrix stops the ruleset
  requiring it, and auto-merge then merges on checks that never ran. Update the
  ruleset in the same change.
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

## Two names

The repository is **`lunox-work/sandbox-factory`** — `lunox-work` is the owning
organization. **`feversoul`** is the maintainer's personal account: it appears in
`.github/CODEOWNERS`, `package.json`'s `author`, and the README copyright.
Repository URLs take the org.
