# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, CodeRabbit autofix)
working in this repository. Humans should read [CONTRIBUTING.md](./CONTRIBUTING.md)
instead — this file covers the same ground plus what an agent needs to not break
the automation.

## What this repository is

An npm-workspaces monorepo holding an HTTP API, a React dashboard, a VS Code
extension, and the packages they share. One package — `packages/core` — is
published to npm as `sandbox-factory`; everything else is private.

The substance of the repo is its automation: CI across two Node versions, CodeQL
and Scorecard security scanning, Dependabot, auto-merge on green, release-please,
and CodeRabbit review. Treat that automation as the thing being maintained — see
[docs/ci.md](./docs/ci.md) and [docs/github-apps.md](./docs/github-apps.md).

### The workspaces

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

**Before adding code, work out which workspace it belongs in.** Read
[docs/architecture.md](./docs/architecture.md) — it has the dependency rules and
the reasoning. The short version:

- `packages/core` has **zero dependencies** and holds the todo domain rules
  (title validation, toggling, filtering, counts). Everything else asks it
  rather than restating them — including `packages/shared`, whose zod schemas
  derive their limits from core's constants.
- `packages/client` must stay platform-neutral: `fetch` only, no `node:*`, no
  `vscode`. Its tsconfig sets `types: []` so a `node:` import fails to compile.
  That is a guardrail, not an oversight — do not "fix" it by adding
  `@types/node`.
- Only `apps/extension` may import `vscode`.
- Apps never import each other. Shared logic moves down into a package.

## Setup

Requires Node.js 22 or newer.

```bash
npm ci
```

Use `npm ci`, not `npm install`, unless you are deliberately changing
dependencies — `npm install` rewrites `package-lock.json` and produces a noisy
diff that CI will flag.

## The check you must run before declaring work done

```bash
npm run verify
```

That is lint, format check, build, and test-with-coverage across **every**
workspace — exactly what [the CI workflow](./.github/workflows/ci.yml) runs, in
the same order. The [`pre-push` hook](./.husky/pre-push) runs it too, so a
failure here means the push is rejected before the code ever reaches GitHub.

Each step fans out through turbo, which builds in dependency order: a change to
`packages/core` is type-checked against every consumer before it can merge.
Running one workspace's tests proves nothing about the others — run the whole
thing.

To iterate on a single workspace, use turbo's filter — it runs that workspace's
tasks and everything it depends on:

```bash
npx turbo run lint test --filter=@sandbox-factory/api
```

That is for speed during development, never the final check. Note `verify` itself
exists only at the root, so `npm run verify --workspace <name>` fails with a
missing-script error.

Run the whole thing. A passing `npm test` alone does not mean CI is green: the
formatting check is a separate gate that trips on unformatted Markdown just as
readily as on unformatted code.

**Every PR auto-merges once its required checks pass.** There is no human click
between green CI and code landing on `main`, so `npm run verify` passing is not a
formality — it is the gate. Do not push work you have not actually verified, and
do not use `git push --no-verify` to get around a failure you have not understood.

| Command                | What it does                                       |
| ---------------------- | -------------------------------------------------- |
| `npm run verify`       | All of the below, in CI's order — run this one     |
| `npm run lint`         | Type-check every workspace with no emit            |
| `npm run format:check` | Fail if anything is unformatted                    |
| `npm run format`       | Fix formatting in place                            |
| `npm run build`        | Build every workspace in dependency order          |
| `npm test`             | Test every workspace, enforcing its own thresholds |

## Conventions that are load-bearing

**Make targets must work from a fresh clone.** `make up` and `make ext` are the
two commands the README puts in front of a new contributor, and both have to
succeed with nothing installed. Host targets therefore depend on a
`node_modules` stamp rule, and the extension targets additionally depend on
`ext-deps`: esbuild inlines the workspace packages from their `dist/`, so those
must be built before the bundle can resolve them. Dropping either prerequisite
breaks the first thing a new contributor types, and it will not show up on a
machine that already has the repo built — test it in a clean clone.

**The `Makefile` delegates; it never reimplements.** Every app target shells out
to the matching npm script, so `make test` and `npm test` cannot diverge. Add a
target when it wraps something that already exists — never put build or test
logic in the Makefile itself, and never let a target's behaviour drift from the
script it names. CI calls the npm scripts directly and does not use `make`.

**`docker-compose.yml` has two profiles, and neither is required.** `dev` runs
the API and web app in containers with the source bind-mounted; `prod` builds
the real images and serves the web app through nginx. Postgres and SeaweedFS
start with both.

**The auth table names in `packages/db/src/schema.ts` are matched by string at
runtime.** Better Auth's Drizzle adapter resolves a model as `schema[modelName]`
and a column as `table[fieldName]`, so the exported consts must stay **singular**
(`user`, not `users`) and the column _properties_ must stay **camelCase**
(`emailVerified`), even though the columns they map to are snake_case. Nothing
catches a rename at compile time — it surfaces as a failed sign-in against a
real database. `packages/db/test/auth-schema.test.ts` asserts both rules; if you
are changing those tables, read the comment above them first.

**Email and password sign-in is off, and that is a decision, not a gap.** It is
disabled by `emailAndPassword` never being enabled in `apps/api/src/auth.ts`.
Note that Better Auth still _defines_ `auth.api.signUpEmail` when the feature is
off, so asserting that the property is absent passes for the wrong reason —
`apps/api/test/auth.test.ts` asserts on the 400 response instead. Do not "fix"
that by enabling the feature.

**`createApp` without an `auth` option serves 503, not todos.** That branch is
what stops a deploy that forgets the auth environment from silently exposing
every user's data, and it is why `auth` is optional on the factory at all —
route tests need to build an app without an OAuth client. Adding a route under
`/api/v1` puts it behind the session guard automatically; adding one outside
that prefix does not, so think about which you want.

**A session is not an entitlement.** Every `TodoStore` method takes the owner
as its first argument, and the Postgres store puts it in the `WHERE` clause
rather than checking it afterwards. Do not add a store method that omits it,
and do not take the owner from a request body — it comes from
`c.get("user").id` and nowhere else. This is not hypothetical: the todo routes
once sat behind the session guard with no `user_id` column at all, which served
every signed-in user the entire table while looking protected. `createInMemoryStore`
enforces the same boundary because a laxer test double would hide exactly that
bug. Another user's id is a 404, never a 403.

**The API requires Postgres, but the test suite does not.** `apps/api` will not
boot without `DATABASE_URL` — there is no in-memory fallback, because a server
that quietly keeps todos in a process about to restart looks healthy and loses
data. `createInMemoryStore` still exists in `apps/api/src/store.ts`, but it is
a **test double**: route tests run against it so they need no container.

That distinction is load-bearing. **No test may depend on a running container**,
and `npm run verify` has to pass on a machine with Docker stopped. When adding
tests to `packages/db`, test the mapping and the store against the fake in
`packages/db/test/fake-db.ts` rather than reaching for a real connection.

`client.ts` and `migrate.ts` in `packages/db` are covered without a database:
`postgres()` is lazy, so a pool can be built and drained with nothing
listening, and `runMigrations` takes its two collaborators as optional
parameters so the close-on-failure path can be tested. What is _not_ covered
there is whether the SQL applies — verify that with `make migrate` against a
live database.

Running on the host with `npm run dev` stays the default and the fastest path,
but it now needs `make db-up && make migrate` first.

Two container details that look odd and are deliberate:

- The dev services bind-mount the repo and then shadow every `node_modules`
  with an anonymous volume. Without that the container would use the host's
  tree, which on macOS holds darwin binaries that do not run on linux.
- Both Dockerfiles build from the **repo root**, not their own directory
  (`docker build -f apps/api/Dockerfile .`). The apps import workspace packages
  that live outside `apps/*`, so a narrower context cannot see them. They copy
  the manifests first and install before copying source, so editing a file does
  not reinstall dependencies.

**The VS Code extension is not containerized, and that is not an oversight.** It
has no server process — it is a bundle the editor on the host loads — so there
is nothing for a container to run. `make ext-watch` and `make ext-package`
handle it on the host. Do not add an extension service to compose.

Its dev loop is split in two, which is why `ext-watch` only does half the job:
esbuild rebuilds `dist/extension.js` on save, and VS Code loads it. The second
half is the editor's, not ours — `debug.extensionHost.autoReload` in
`.vscode/settings.json` is what makes the Development Host pick up a rebuild.
Both halves are needed for an edit-and-see loop; neither is sufficient alone.

**Dev servers run compiled output too, not sources.** `apps/api`'s `dev` script
runs `tsc --watch` and `node --watch dist/server.js` side by side under
`concurrently`. Do not "simplify" it to `node --experimental-strip-types
src/server.ts`: on Node 22 that flag does not map the `.js` specifiers NodeNext
requires back onto the `.ts` files on disk, so the process dies on its first
relative import.

**Tests run against compiled output, not sources.** `npm test` compiles to
`dist-test/` and runs `node --test dist-test/test/*.test.js`. Do not add a test
runner that executes TypeScript directly — the point is to test what ships.

**Import extensions differ by workspace, and both spellings are correct.**
Workspaces on `NodeNext` — `core`, `shared`, `client`, `api` — write
`from "../src/index.js"` even though the file on disk is `index.ts`. Workspaces
on `Bundler` — `web`, `extension` — write `from "./tree"` with no extension.
Check which config the workspace extends before adding an import; moving a file
between the two means adjusting its imports.

**Extend `tooling/tsconfig`, never copy compiler options.** Four variants exist
(`base`, `node`, `react`, `extension`). If a workspace needs an option none of
them provides, consider whether it belongs in `base.json` for everyone before
overriding it locally — and say why in a comment if you do override.

**`verbatimModuleSyntax` is on.** Type-only imports must say so:
`import type { Foo } from "./foo.js"`. A plain import of a type will fail the
build.

**`strict` and `noUncheckedIndexedAccess` are on.** Indexing an array yields
`T | undefined`. Narrow it rather than reaching for `!` — the non-null assertion
is what `noUncheckedIndexedAccess` exists to prevent.

**Commit messages are Conventional Commits, and they are not cosmetic.**
release-please parses them to build the changelog and decide the next version.
`fix:` produces a patch bump, `feat:` a minor, a `!` or `BREAKING CHANGE:`
footer a major. A change that lands as `chore:`, `docs:` or `ci:` is not
user-facing and gets no release at all. Pick the prefix based on what the change
does for a consumer of the package, not on how large it felt to write.

**The PR title is the only commit message that survives.** `main` accepts squash
merges only, so every PR lands as a single commit whose subject is the PR title;
the individual commit subjects are demoted to bullets in the body, where
release-please does not look for the release type.

This has a sharp consequence. A PR titled `docs: ...` that contains a `fix:`
commit produces **no release** — release-please reports "no user facing commits
found" and skips, and nothing warns you. If a PR contains any user-facing change,
**the PR title itself must carry the `fix:` or `feat:` prefix**, whatever else is
in the branch. When a PR mixes a fix with docs or CI work, title it for the fix.

**`CHANGELOG.md` is generated.** release-please owns it. It lives at
`packages/core/CHANGELOG.md`, not the repo root, because `packages/core` is the
only released package. Never hand-edit it; it is in `.prettierignore` precisely
because its generated formatting does not match Prettier's.

**release-please runs in manifest mode and watches `packages/core` only.** A
change confined to `apps/*` produces no release, correctly — those are not
published. A `feat:` or `fix:` that touches `packages/core` does. If you add a
package that should be published, it needs an entry in both
`release-please-config.json` and `.release-please-manifest.json`, and the new
`package.json` must not be `"private": true`.

**`dist/` and `dist-test/` are build output.** They are gitignored. Editing them
does nothing that survives the next build.

## Branch, PR, and merge rules

`main` is protected by a repository ruleset. You cannot push to it directly:
force-pushes and deletion are blocked, and all changes go through a pull request
that squash-merges. Branch off `main` as `fix/short-description` or
`feat/short-description`.

Three status checks must pass before merge: `Test (Node 22)`, `Test (Node 24)`,
and `Analyze` (CodeQL). The ruleset also requires branches to be up to date with
`main` before merging, so a stale branch needs a rebase even when its own checks
are green.

**Those names are load-bearing.** Branch protection matches required checks by
job name. Renaming the `test` job in [`ci.yml`](./.github/workflows/ci.yml), or
changing the Node matrix values that interpolate into its name, silently stops
the ruleset from requiring it — and auto-merge will then merge pull requests on
checks that never ran, with nothing warning you. If a job name must change,
update the repository ruleset in the same change.

Note that `engines` requires Node 22 or newer: the coverage threshold flags do
not exist on Node 20.

**Opening a PR is the last decision point.** Approving reviews are not required
and [`auto-merge.yml`](./.github/workflows/auto-merge.yml) arms auto-merge on
every PR, so once you open one it will merge itself the moment the required
checks go green. Nobody clicks anything. Open a PR only when you would be
comfortable with the change landing on `main` unattended; if you want a human to
look first, say so in the PR body and open it as a **draft** — auto-review and
auto-merge both skip drafts.

Keep each PR to one logical change, fill in the template, and link the issue it
closes.

## Coverage

Thresholds are **per workspace**, set in each one's `test` script: 90% for the
packages, 80% for `apps/api`. Packages are held higher because they are pure
logic with no I/O to work around. Each exits non-zero below its own numbers.

New code needs tests in the same change — an under-tested PR fails the required
`Test` jobs and simply never merges.

Each package measures only its own source: the
`--test-coverage-include="dist-test/src/**"` flag scopes the report to this
package. Without it, imported sibling workspaces are counted against this
package's threshold — `core`'s compiled output dragging `api`'s numbers down,
for instance — which is both wrong and confusing.

It must be an _include_, not a relative exclude: workspaces sit at different
depths (`packages/core` vs `apps/api`), so no single `../**` pattern matches the
siblings from every one of them. Leave that flag alone.

**A file no test imports is invisible to the thresholds, so every workspace
also runs `assert-all-covered`.** Node's `--test-coverage-*` flags only police
files the run actually loaded: add a source file that nothing imports and the
report omits it entirely, reporting 100% and passing. That is backwards for
catching new untested code, so each `test` script writes the report to
`dist-test/coverage.txt` and then asserts every compiled source file appears in
it.

If it fails, add a test that imports the file. Only if the file genuinely
cannot be loaded by a test — a barrel of re-exports, or a CLI whose module body
runs on import — add its compiled name as an argument to `assert-all-covered`
in that workspace's `test` script. Three are listed today: `index.js` and
`migrate-cli.js` in `packages/db`, and `server.js` in `apps/api`.

**Do not put the test command on the left of a pipe.** npm runs scripts under
`sh` without `pipefail`, so a pipeline's exit status is its _last_ command's —
piping a failing test run into anything makes the suite exit 0 and CI go green
on red tests. That is why the scripts redirect to a file and `&&`-chain instead.

Do not lower the thresholds to make a change pass. They are what keeps untested
code from auto-merging to `main`; add the test instead. If a threshold genuinely
needs to move, that is a decision to raise with the maintainer, not a side effect
of an unrelated PR.

`apps/web` runs Vitest with Testing Library (`vitest run`, jsdom). It was a
placeholder that always passed until the account settings page shipped three
bugs behind a green `npm run verify` — an empty handle field, a provider row
that claimed "linked" with no address, and an unlink button that sent the wrong
id. A passing placeholder is worse than no script: it implies coverage that
does not exist.

Web tests fake the server at the `fetch` and auth-client boundary rather than
mocking component internals, so they assert what a person sees given a server
response. When fixing a UI bug, check the test fails before the fix — a test
written after the fact that never saw red proves nothing.

`apps/extension` still has a placeholder. If you add meaningful logic there,
add a real runner in the same change.

## Things not to do

- **Do not edit `.github/workflows/*.yml` casually.** Several workflows run on
  `pull_request_target`, which executes with write permissions in the context of
  the base branch. A careless change there is a privilege-escalation bug, not a
  style issue. Read [docs/ci.md](./docs/ci.md) before touching them.
- **Do not bump dependencies by hand.** Dependabot does it weekly, and its PRs
  auto-merge on green like any other. A manual bump collides with its open PRs.
- **Do not add a dependency without saying why in the PR body.** Say which
  workspace it goes in, too. `packages/core` has **zero** runtime dependencies
  and that is a deliberate property of the published package — adding one there
  is a much bigger decision than adding one to an app, and needs to be raised
  rather than slipped in.
- **Do not add `@types/node` to `packages/client`.** Its `types: []` is what
  stops a `node:` import from reaching the browser and the extension bundle. A
  type error there means the import is wrong, not the config.
- **Do not commit secrets.** `.env` is gitignored, `.env.example` is the template.
  The credentials in `docker-compose.yml` are local development values and must
  stay that way — production config comes from the environment.
- **Do not hand-edit `packages/db/drizzle/`.** drizzle-kit generates it from
  `src/schema.ts` via `npm run db:generate --workspace @sandbox-factory/db`.
  It is in `.prettierignore` for the same reason `CHANGELOG.md` is.
- **Do not weaken the `permissions:` blocks in workflows.** They are
  least-privilege on purpose and OpenSSF Scorecard grades them.

## Two names, and they are not interchangeable

The repository lives at **`lunox-work/sandbox-factory`** — `lunox-work` is the
organization that owns it. **`feversoul`** is the maintainer's personal account,
a member of that org.

Repository URLs take the org: `https://github.com/lunox-work/sandbox-factory/...`.
Anything naming a person takes the user: `@feversoul` in
[`.github/CODEOWNERS`](./.github/CODEOWNERS), the `author` field in
`package.json`, the copyright line in the README.

The scaffold originally used `feversoul/sandbox-factory` for both, which meant
every documentation link 404'd — there is no repository at that path. If you are
adding a link, check which of the two you need.
