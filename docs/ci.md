# CI and automation

Workflows in [`.github/workflows/`](../.github/workflows/), plus branch
protection on `main`.

| Workflow              | Does                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `ci.yml`              | Lint, format, build, test on Node 22 and 24; worker image smoke         |
| `e2e.yml`             | Playwright browser smoke on Chromium — the `Browser smoke` check        |
| `autofix.yml`         | Pushes `npm run format` fixes to same-repository PRs                    |
| `codeql.yml`          | Security analysis — the `Analyze` check                                 |
| `auto-merge.yml`      | Arms auto-merge on every PR                                             |
| `labeler.yml`         | Labels PRs by path                                                      |
| `cd.yml`              | Deploys `main`, then tags and releases                                  |
| `release.yml`         | Builds, signs and attaches release artifacts                            |
| `terraform.yml`       | Validates infra; plans on PRs only, with a read-only role               |
| `deploy-watchdog.yml` | Daily: is production at `main`'s head?                                  |
| `security-sweep.yml`  | Nightly security sweep                                                  |
| `scorecard.yml`       | OpenSSF supply-chain posture, weekly. Pinned to an exact action version |

## Branch protection

The target configuration is [main-ruleset.json](../.github/main-ruleset.json):
one active ruleset, no bypass actors, no force-push/deletion, linear history
and squash-only PR merges. These contexts are required, from their expected
GitHub Apps:

- `Test (Node 22)`, `Test (Node 24)`, `Worker image smoke`,
  `Browser smoke (Chromium)`, `Analyze`: GitHub Actions.
- `CodeQL`: GitHub Advanced Security (the findings result, not just the scanner job).

**A PR merges once CI passes.** No approving review is required, review
threads do not block, and CodeRabbit is advisory: read its findings, but
nothing waits for them. Draft a PR to hold it back.

Checks are not strict: a PR does not have to be up to date with `main` to
merge. Nothing in this repository updates PR branches, and the squash lands on
a linear history either way. `ci.yml` runs again on the push to `main`.

An absent/renamed check blocks merging; update policy and job names together.
Labeler and Scorecard remain advisory.

The checked-in policy is not automatically applied by a PR. Apply it with
`gh api -X PUT repos/lunox-work/sandbox-factory/rulesets/<id> --input .github/main-ruleset.json`.

**Trust is the branch's repository, not the author's association.** Only
someone with write access can push a branch here, so a same-repository PR is
trusted and a fork's needs manual maintainer handling. `author_association`
is not used: the Actions token cannot see a private organization membership,
so it reported the maintainer's own PRs as untrusted and nothing ever merged.

## CI (`ci.yml`)

Runs on pushes to `main` and on pull requests, over Node 22 and 24 with
`fail-fast: false`. Node 20 lacks the coverage threshold flags.

Each job runs `npm ci --ignore-scripts` → `npm run lint` → `npm run format:check`
→ `npm run build` → `npm test` — the same sequence as `npm run verify`, which
the pre-push hook runs. Keep them identical.

CI also runs `npm run test:bounty-concurrency --workspace @sandbox-factory/db`
sequentially after ordinary tests, against its disposable Postgres service.
This scratch-database suite fails when Postgres is unavailable.

CI then does three things `verify` does not: it runs against a **Postgres
service container and a SeaweedFS fixture**, asserts the database-backed tests actually ran rather than
skipping, and asserts the build recorded its commit. The S3 regression uploads
a stream and downloads its signed URL, checking exact bytes and hash. It catches
gateway incompatibilities such as optional AWS checksum trailer framing. Turbo
passes the database URL and test S3 endpoint into the test tasks and their cache
keys.

- **Lint also checks import boundaries.** `npm run lint` runs each workspace's
  `tsc --noEmit`, then `npm run lint:deps`
  ([dependency rules](./architecture.md#dependency-direction)).
- **Format is a separate gate from lint.**
  Unformatted Markdown fails CI as hard as unformatted TypeScript.
  [`autofix.yml`](../.github/workflows/autofix.yml) runs `npm run format` on
  each same-repository PR and pushes any diff as a `style:` commit, which
  reruns CI. It uses `AUTO_MERGE_TOKEN` for the push, so CI fires on the new
  head, and never in the job that runs the PR's code. It skips forks,
  Dependabot and `.github/workflows/` (the token has no Workflows permission).
  Type errors have no mechanical fix.
- **`npm test` tests compiled output**, via `tsconfig.test.json` into
  `dist-test/`, catching module-resolution and emit problems a TypeScript-native
  runner would paper over.
- **`npm test` enforces coverage**, per workspace, in each workspace's own
  `test` script: 90% for the packages, 80% for `apps/api`; `apps/web` runs
  Vitest without thresholds. Do not lower one to make a PR pass — add the test.
- **`--ignore-scripts`** skips husky's `prepare`, which fails outside a git work
  tree.

The `Worker image smoke` job builds the pinned ARM64 worker image and runs the
real Graphify fixture pipeline without credentials. It is in the checked-in
required-check policy; apply that policy when enabling Phase 3 so a Python
regression cannot merge while only the Node tests pass. The prerequisite DNS
change must be applied before any worker launches; CD checks both the event
filter and the Lambda's configured API service group before registering a worker
revision. Worker tags are immutable, and rollback dispatches reuse existing
worker images instead of rebuilding them.

## CodeQL and Scorecard

`codeql.yml` runs `javascript-typescript` with the `security-and-quality` suite
on pushes to `main`, on PRs, and weekly — the scheduled run catches new
advisories against unchanged code.

Both it and `scorecard.yml` are gated on the repository being public, since
uploading results requires Advanced Security. **If the repository goes private
the job skips, and GitHub reports a skipped required check as successful**.
Revisit CodeQL licensing and policy if visibility changes.

## Dependabot

[`dependabot.yml`](../.github/dependabot.yml) watches npm and GitHub Actions
weekly, capped at five open PRs. Dev-dependency minor and patch updates are
grouped into one PR.

## Auto-merge

[`auto-merge.yml`](../.github/workflows/auto-merge.yml) arms GitHub's auto-merge
on ready same-repository PRs except a **Dependabot major**, which waits for a human.
The squash then lands once every required check passes.

**It merges with the `AUTO_MERGE_TOKEN` secret, not the default
`GITHUB_TOKEN`.** GitHub raises no events for pushes made with the default
token, so a merge performed with it produces a `main` that CI and CD never
observe, and nothing deploys. If the secret is absent or unusable the workflow fails; it never falls back to
the default token. Rotate it with
[`scripts/rotate-token.sh`](../scripts/rotate-token.sh).

Two things make this safe:

- **`--auto` enables auto-merge, or merges immediately if already eligible.** GitHub merges only once every
  required check passes. Nothing bypasses the ruleset.
- **Verification happens before the push.** The
  [`pre-push` hook](../.husky/pre-push) runs the same `npm run verify` as CI.

The workflow runs on `pull_request_target`, so it executes with the base
branch's permissions and secrets even for a fork's PR. **It never checks out or
executes PR code — preserve that in any edit.** Doing so would hand a fork the
ability to merge to `main`.

## Labeler (`labeler.yml`)

Labels PRs by path per [`.github/labeler.yml`](../.github/labeler.yml). Also
`pull_request_target`, but it holds only `pull-requests: write` and never
touches PR content.

That permission cannot create a label, so one named in `labeler.yml` that does
not exist on the repository is silently skipped. Create labels before
referencing them.

## Release (`cd.yml`, the `release` job)

**Every merge to `main` that deploys and carries a releasable commit becomes a
release.** There is no release PR and no tagging step.

The ordering is the design. `cd.yml` works out the next version _before_ it
builds, because the version and tag are compiled into the artifact; deploys;
verifies against the live site; and only then tags the deployed commit and
publishes the GitHub release. A tag therefore means "this ran in production",
not "this merged".

[`scripts/next-version.mjs`](../scripts/next-version.mjs) decides the bump from
the commit subjects since the last tag:

| Commit                                                 | Bump           |
| ------------------------------------------------------ | -------------- |
| `!` suffix, or a `BREAKING CHANGE:` footer             | major          |
| `feat`                                                 | minor          |
| `fix`, `perf`, `revert`, `build`, `refactor`           | patch          |
| anything else (`docs`, `chore`, `ci`, `test`, `style`) | **no release** |

- A chore-only merge still deploys; it just cuts no version.
- A **docs-only** merge does not deploy: `cd.yml` has `paths-ignore` for
  `**.md`, `docs/**` and `.github/ISSUE_TEMPLATE/**`. A docs fix therefore
  cannot force a redeploy.
- **The PR title is the squash commit**, and so decides the version. Branch
  commit subjects are not parsed: a PR titled `docs:` releases nothing even if
  it contains a `fix:` commit. If an expected release did not happen, check the
  merged commit's subject on `main` first.
- **One release is one sha.** The tag is cut on the deployed commit and nothing
  is pushed to `main`, so the footer's `1.2.3+abc1234`, the release page, the
  asset filenames and the attestation all name the same commit.
- **Tags are the version of record.** Nothing bumps `package.json`; the next
  version is computed from the last tag. `/version` and the footer say what is
  live.

The release job then dispatches
[`release.yml`](../.github/workflows/release.yml), which builds, signs and
attaches the artifacts. It must be dispatched: the tag is pushed with the
default `GITHUB_TOKEN`, which raises no `push` event, so `release.yml`'s own tag
trigger fires only for a tag pushed by a person.

`CHANGELOG.md` is a historical record frozen at 1.0.0, from when release-please
managed releases (until 2026-09-17). GitHub's release notes are the changelog
now. The file is in [`.prettierignore`](../.prettierignore).

### When a deploy goes wrong

Deploys queue rather than cancel (`concurrency: deploy-production`), so one
stuck run holds up every later one — hence `timeout-minutes: 20` on a deploy
that normally takes four to seven. GitHub keeps only one run waiting per group;
a newer merge replaces it, which is fine, because the newer commit includes the
older.

A failed or cancelled deploy cuts no tag, and the next successful one picks the
version up, so nothing is skipped. Production can therefore briefly report a
version newer than the newest tag.

To retry by hand: `gh workflow run cd.yml`. A dispatched run deploys but never
tags; only a push to `main` does.

## Publishing

Nothing publishes to npm. It would need a new workflow triggered on release,
using a scoped npm token or trusted publishing.
