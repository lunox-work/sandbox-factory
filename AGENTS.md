# AGENTS.md

Instructions for coding agents (Claude Code, Codex, Cursor, CodeRabbit autofix)
working in this repository. Humans should read [CONTRIBUTING.md](./CONTRIBUTING.md)
instead — this file covers the same ground plus what an agent needs to not break
the automation.

## What this repository is

A TypeScript library scaffold published as an ESM package. `src/index.ts` is the
only source file and currently exports a placeholder `hello()`. The substance of
the repo is its automation: CI across two Node versions, CodeQL and Scorecard
security scanning, Dependabot, auto-merge on green, release-please, and CodeRabbit
review. Treat that automation as the thing being maintained — see
[docs/ci.md](./docs/ci.md) and [docs/github-apps.md](./docs/github-apps.md).

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

That is lint, format check, build, and test-with-coverage — exactly what
[the CI workflow](./.github/workflows/ci.yml) runs, in the same order. The
[`pre-push` hook](./.husky/pre-push) runs it too, so a failure here means the
push is rejected before the code ever reaches GitHub.

Run the whole thing. A passing `npm test` alone does not mean CI is green: the
formatting check is a separate gate that trips on unformatted Markdown just as
readily as on unformatted code.

**Every PR auto-merges once its required checks pass.** There is no human click
between green CI and code landing on `main`, so `npm run verify` passing is not a
formality — it is the gate. Do not push work you have not actually verified, and
do not use `git push --no-verify` to get around a failure you have not understood.

| Command                  | What it does                                        |
| ------------------------ | --------------------------------------------------- |
| `npm run verify`         | All of the below, in CI's order — run this one      |
| `npm run lint`           | Type-check `src` and `test` with no emit            |
| `npx prettier --check .` | Fail if anything is unformatted                     |
| `npm run format`         | Fix formatting in place                             |
| `npm run build`          | Compile `src` to `dist/`                            |
| `npm test`               | Compile to `dist-test/`, test, enforce 80% coverage |

## Conventions that are load-bearing

**Tests run against compiled output, not sources.** `npm test` compiles to
`dist-test/` and runs `node --test dist-test/test/*.test.js`. Do not add a test
runner that executes TypeScript directly — the point is to test what ships.

**Import with `.js` extensions, from `.ts` files.** The project is
`"type": "module"` with `moduleResolution: NodeNext`, so a test importing the
source writes `from "../src/index.js"` even though the file on disk is
`index.ts`. This looks wrong and is correct.

**`verbatimModuleSyntax` is on.** Type-only imports must say so:
`import type { Foo } from "./foo.js"`. A plain import of a type will fail the
build.

**`strict` and `noUncheckedIndexedAccess` are on.** Indexing an array yields
`T | undefined`. Narrow it rather than reaching for `!` — the non-null assertion
is what `noUncheckedIndexedAccess` exists to prevent.

**Commit messages are Conventional Commits, and they are not cosmetic.**
release-please parses them to build the changelog and decide the next version.
`fix:` produces a patch bump, `feat:` a minor, a `!` or `BREAKING CHANGE:`
footer a major. A change that lands as `chore:` gets no changelog entry at all.
Pick the prefix based on what the change does for a consumer of the package, not
on how large it felt to write.

**`CHANGELOG.md` is generated.** release-please owns it. Never hand-edit it, and
note it is in `.prettierignore` precisely because its generated formatting does
not match Prettier's.

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

`npm test` enforces 80% line, branch, and function coverage and exits non-zero
below any of them. New code needs tests in the same change — an under-tested PR
fails the required `Test` jobs and simply never merges.

Do not lower the thresholds in `package.json` to make a change pass. They are
what keeps untested code from auto-merging to `main`; add the test instead. If a
threshold genuinely needs to move, that is a decision to raise with the
maintainer, not a side effect of an unrelated PR.

## Things not to do

- **Do not edit `.github/workflows/*.yml` casually.** Several workflows run on
  `pull_request_target`, which executes with write permissions in the context of
  the base branch. A careless change there is a privilege-escalation bug, not a
  style issue. Read [docs/ci.md](./docs/ci.md) before touching them.
- **Do not bump dependencies by hand.** Dependabot does it weekly, and its PRs
  auto-merge on green like any other. A manual bump collides with its open PRs.
- **Do not add a dependency without saying why in the PR body.** The package has
  zero runtime dependencies today; the first one is a real decision.
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
