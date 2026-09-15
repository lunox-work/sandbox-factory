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

Do not lower the thresholds to make a change pass. They are what keeps untested
code from auto-merging to `main`; add the test instead. If a threshold genuinely
needs to move, that is a decision to raise with the maintainer, not a side effect
of an unrelated PR.

`apps/web` and `apps/extension` currently have placeholder `test` scripts. If you
add meaningful logic to either, add a real test runner in the same change rather
than leaving the placeholder to imply coverage that does not exist.

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
