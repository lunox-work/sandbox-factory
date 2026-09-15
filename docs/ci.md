# CI and automation

Six workflows in [`.github/workflows/`](../.github/workflows/), plus branch
protection on `main`. This document explains what each one does and, where the
choice is not obvious, why it is set up that way.

## Branch protection

`main` is governed by a repository ruleset named **main protection**
(Settings → Rules → Rulesets), not by the older branch-protection API. It is
active and enforces:

- **No deletion, no force-push** of `main`.
- **Pull request required**, squash-merge only. Zero approving reviews are
  required — a solo-maintainer convenience — but unattributed changes need an
  extra approval.
- **Required status checks**: `Test (Node 22)`, `Test (Node 24)`, `Analyze`.
  Strict mode is on, so a branch must be up to date with `main` before it can
  merge.

Repository admins can bypass the ruleset. That bypass exists so release-please
and the initial scaffold could land; it is not meant for routine use.

Note which checks are _not_ required: `CodeRabbit`, `label`, and
`Scorecard analysis`. They report on PRs but never block a merge, which is
deliberate — an advisory review and a labeling bot should not be able to wedge
the repository shut.

This list matters more than it used to: every PR is auto-merged on green, so the
required checks are exactly the set of things that can stop a bad change. A check
that is not on this list does not gate anything.

## CI (`ci.yml`)

Runs on pushes to `main` and on pull requests. A matrix over Node 22 and 24 with
`fail-fast: false`, so one version failing still shows you the others.
Concurrency is grouped per ref with `cancel-in-progress`, so a force-push
supersedes the run it replaced instead of queueing behind it.

Node 20 was dropped because the coverage threshold flags (`--test-coverage-lines`
and friends) do not exist there — it rejects them outright. Enforcing coverage on
some supported versions but not others would have meant a job that passes on
under-tested code, so the floor moved to 22 instead. Node 20 reaches end-of-life
in April 2026.

Each matrix job runs, in order: `npm ci --ignore-scripts` → `npm run lint` →
`npx prettier --check .` → `npm run build` → `npm test`. That is the same
sequence as `npm run verify`, which the pre-push hook runs locally — the two are
kept identical on purpose, so a green local run means a green CI run.

Details worth knowing:

- **The format check is a separate gate from lint.** `npm run lint` is a
  type-check (`tsc --noEmit`); it has no opinion about formatting. Unformatted
  Markdown fails CI exactly as hard as unformatted TypeScript. `npm run format`
  fixes it.
- **`npm test` tests compiled output.** It compiles `src` and `test` into
  `dist-test/` via `tsconfig.test.json`, then runs Node's built-in test runner
  over the emitted JavaScript. This catches module-resolution and emit problems
  that a TypeScript-native runner would paper over.
- **`npm test` also enforces coverage.** It runs with
  `--experimental-test-coverage` and 80% thresholds for lines, branches, and
  functions. Node exits non-zero when coverage falls below any of them, so an
  under-tested change fails the `Test` jobs — which are required checks, and so
  block the auto-merge. Test files are excluded from the measurement via
  `--test-coverage-exclude`.
- **`--ignore-scripts` on install** skips husky's `prepare` script, which has
  nothing to install on a CI runner and fails outside a git work tree.

## Coverage thresholds

Set in the `test` script in [`package.json`](../package.json), currently 80% for
lines, branches, and functions. To change them, edit that one script — the hook
and CI both inherit it.

The thresholds are the load-bearing part of auto-merge: since every PR merges on
green, they are what stops untested code from reaching `main` unattended. Lowering
them to make a PR pass is almost always the wrong move; add the test instead.

## CodeQL (`codeql.yml`)

Static analysis for `javascript-typescript` with the `security-and-quality`
query suite. Runs on pushes to `main`, on pull requests, and weekly on a cron —
the scheduled run is what catches newly published advisories against code that
has not changed.

The job is gated on `github.event.repository.private == false`. Uploading code
scanning results requires GitHub Advanced Security, which is free for public
repositories and paid otherwise. If this repository is ever made private, this
job will skip rather than fail — but `Analyze` is a required status check, so a
skipped job would leave PRs unmergeable until the ruleset is updated too.

## OpenSSF Scorecard (`scorecard.yml`)

Scores the repository's supply-chain posture and publishes the result. Runs
weekly, on pushes to `main`, and whenever a branch protection rule changes.

Same public-repository gate as CodeQL, for the same reason. The action is pinned
to an exact version (`ossf/scorecard-action@v2.4.4`) rather than a major tag —
Scorecard itself penalizes unpinned dependencies, and a workflow that fails its
own audit is not a good look. `persist-credentials: false` on checkout keeps the
token out of the git config, which Scorecard also checks for.

## Dependabot

[`dependabot.yml`](../.github/dependabot.yml) watches npm and GitHub Actions
weekly, capped at five open PRs. Development dependencies with minor and patch
updates are grouped into a single PR rather than arriving as a dozen.

## Auto-merge

[`auto-merge.yml`](../.github/workflows/auto-merge.yml) arms GitHub's auto-merge
on every pull request, so anything that goes green lands on `main` without a
manual click. Release PRs included: a merged `fix:` or `feat:` produces a release
PR, which then merges and tags itself.

The one exception is a **Dependabot major**, which waits for a human — that is
where breaking changes live.

Two things make this safe rather than reckless:

- **`--auto` arms a queue; it does not merge.** GitHub merges only once every
  required status check passes. Nothing in the workflow bypasses the ruleset, so
  the required checks — including the coverage thresholds enforced inside the
  `Test` jobs — remain the real gate.
- **Verification happens before the push, not after.** The
  [`pre-push` hook](../.husky/pre-push) runs the same `npm run verify` that CI
  runs, so code that would fail CI never reaches GitHub in the first place.

This workflow runs on `pull_request_target`, which means it executes with the
base branch's permissions and access to secrets even for a fork's PR. That is
what makes it able to merge, and also what makes it dangerous. **It never checks
out or executes PR code — preserve that property in any edit.** A
`pull_request_target` workflow that checks out the head ref and runs it is a
well-known privilege-escalation pattern, and here it would hand a fork the
ability to merge to `main`.

Because every PR now merges on green, the pre-push hook and the required checks
are the only things standing between a mistake and `main`. Weakening either one
weakens the whole chain.

## Labeler (`labeler.yml`)

Labels PRs by which paths they touch, per
[`.github/labeler.yml`](../.github/labeler.yml): `documentation`, `ci`,
`dependencies`, `tests`, `source`. Also `pull_request_target`, but this one only
needs `pull-requests: write` and never touches PR content.

## Release (`release-please.yml`)

On every push to `main`, release-please maintains an open release PR that
accumulates changelog entries parsed from Conventional Commit messages. Merging
that PR writes `CHANGELOG.md`, bumps the version in `package.json`, and tags the
release.

**Squash merging means the PR title is the commit message.** Because the ruleset
allows squash merges only, each PR lands on `main` as one commit whose subject is
the PR title — the branch's own commit subjects survive only as bullets in the
body, which release-please does not parse for the release type.

So a PR titled `docs:` or `ci:` produces no release even when it contains a
`fix:` commit. The workflow still runs and still succeeds; the log just says
`No user facing commits found ... skipping`. If you expected a release and did
not get one, check the merged commit's subject on `main` first — that is almost
always the reason. The fix is to title the PR for its user-facing change.

Configuration lives in [`release-please-config.json`](../release-please-config.json)
and [`.release-please-manifest.json`](../.release-please-manifest.json). The
manifest records the last released version (`0.1.0`); the next number comes from
that plus the Conventional Commit prefixes since it.

The config briefly carried `"release-as": "0.1.0"` to stop release-please from
opening the first release as 1.0.0. It was removed once 0.1.0 shipped, because
`release-as` is unconditional — left in place it pins _every_ release to the same
number. If you ever need to force a specific version again, add it back and
remove it in the same cycle.

Because the changelog is generated, `CHANGELOG.md` is listed in
[`.prettierignore`](../.prettierignore); its generated formatting does not match
Prettier's, and without that exclusion every release would break the format
check.

## Publishing

There is no npm publish workflow. release-please tags releases and writes the
changelog, but nothing pushes the package to a registry. If publishing is wanted,
it needs a new workflow triggered on release, using a scoped npm token or
trusted publishing.

## Running the CI checks locally

```bash
npm ci
npm run lint && npx prettier --check . && npm run build && npm test
```
