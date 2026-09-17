# CI and automation

Eleven workflows in [`.github/workflows/`](../.github/workflows/), plus branch
protection on `main`.

| Workflow              | Does                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `ci.yml`              | Lint, format, build, test on Node 22 and 24                             |
| `codeql.yml`          | Security analysis — the `Analyze` check                                 |
| `auto-merge.yml`      | Arms auto-merge on every PR                                             |
| `labeler.yml`         | Labels PRs by path                                                      |
| `cd.yml`              | Deploys `main`, then tags and releases                                  |
| `release.yml`         | Builds, signs and attaches release artifacts                            |
| `terraform.yml`       | Validates infra; plans on PRs only, with a read-only role               |
| `deploy-watchdog.yml` | Daily: is production at `main`'s head?                                  |
| `security-sweep.yml`  | Nightly security sweep                                                  |
| `codeql-autofix.yml`  | Asks CodeQL for a fix on its own findings                               |
| `scorecard.yml`       | OpenSSF supply-chain posture, weekly. Pinned to an exact action version |

## Branch protection

`main` is protected by **two** layers, and both must be satisfied.

A repository ruleset named **main protection** (Settings → Rules → Rulesets):

- No deletion, no force-push.
- Pull request required, squash-merge only. Zero approving reviews.
- Required status checks: `Test (Node 22)`, `Test (Node 24)`, `Analyze`. Strict
  mode is on, so a branch must be up to date with `main` to merge.
- `CodeRabbit`, `label` and `Scorecard analysis` are deliberately **not**
  required: an advisory review and a labeling bot should not be able to wedge
  the repository shut.
- `require_extra_approval_for_unattributed_changes` is off. A solo maintainer
  cannot approve their own PR, so it would deadlock any PR whose commits carry
  a `Co-Authored-By` trailer.

And a **classic branch protection** (Settings → Branches), which adds:

- `required_conversation_resolution` — **every review thread must be resolved
  before the merge**. The most common reason a green PR will not merge.
- `enforce_admins` — so `gh pr merge --admin` overrides none of this.
- Two extra required contexts, `CodeQL` and `CodeRabbit`. **`CodeRabbit` never
  reports a conclusion**, so it is permanently pending. This is a
  misconfiguration, harmless only because auto-merge evaluates the ruleset and
  not this layer. The REST merge API evaluates this layer, so anything merging
  through the API stalls (confirmed on PR #26).

Required checks are matched **by job name**. Renaming a CI job or changing the
Node matrix silently stops the ruleset requiring it — update both together.

## CI (`ci.yml`)

Runs on pushes to `main` and on pull requests, over Node 22 and 24 with
`fail-fast: false`. Node 20 lacks the coverage threshold flags.

Each job runs `npm ci --ignore-scripts` → `npm run lint` → `npm run format:check`
→ `npm run build` → `npm test` — the same sequence as `npm run verify`, which
the pre-push hook runs. Keep them identical.

CI then does three things `verify` does not: it runs against a **Postgres
service container**, asserts the database-backed tests actually ran rather than
skipping, and asserts the build recorded its commit.

- **Format is a separate gate from lint.** `npm run lint` is `tsc --noEmit`.
  Unformatted Markdown fails CI as hard as unformatted TypeScript.
- **`npm test` tests compiled output**, via `tsconfig.test.json` into
  `dist-test/`, catching module-resolution and emit problems a TypeScript-native
  runner would paper over.
- **`npm test` enforces coverage**, per workspace, in each workspace's own
  `test` script: 90% for the packages, 80% for `apps/api`; `apps/web` runs
  Vitest without thresholds. Do not lower one to make a PR pass — add the test.
- **`--ignore-scripts`** skips husky's `prepare`, which fails outside a git work
  tree.

## CodeQL and Scorecard

`codeql.yml` runs `javascript-typescript` with the `security-and-quality` suite
on pushes to `main`, on PRs, and weekly — the scheduled run catches new
advisories against unchanged code.

Both it and `scorecard.yml` are gated on the repository being public, since
uploading results requires Advanced Security. **If the repository goes private
the job skips, and GitHub reports a skipped required check as successful** — PRs
would merge with no scan at all. Revisit the ruleset if visibility changes.

## Dependabot

[`dependabot.yml`](../.github/dependabot.yml) watches npm and GitHub Actions
weekly, capped at five open PRs. Dev-dependency minor and patch updates are
grouped into one PR.

## Auto-merge

[`auto-merge.yml`](../.github/workflows/auto-merge.yml) arms GitHub's auto-merge
on every PR except a **Dependabot major**, which waits for a human.

**It merges with the `AUTO_MERGE_TOKEN` secret, not the default
`GITHUB_TOKEN`.** GitHub raises no events for pushes made with the default
token, so a merge performed with it produces a `main` that CI and CD never
observe, and nothing deploys. If the secret expires the workflow falls back to
the default token and says so in its log; rotate it with
[`scripts/rotate-token.sh`](../scripts/rotate-token.sh).

Two things make this safe:

- **`--auto` arms a queue; it does not merge.** GitHub merges only once every
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
