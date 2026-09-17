# CI and automation

Six workflows in [`.github/workflows/`](../.github/workflows/), plus branch
protection on `main`.

## Branch protection

`main` is protected by **two** layers. Both have to be satisfied, and only the
first is visible under Settings → Rules.

A repository ruleset named **main protection** (Settings → Rules → Rulesets):

- No deletion, no force-push.
- Pull request required, squash-merge only. Zero approving reviews.
- Required status checks: `Test (Node 22)`, `Test (Node 24)`, `Analyze`. Strict
  mode is on, so a branch must be up to date with `main` to merge.

And a **classic branch protection** (Settings → Branches) which adds:

- `required_conversation_resolution` — **every review thread must be resolved
  before the merge**. This is the most common reason a green PR will not merge.
- `enforce_admins` — so `gh pr merge --admin` does **not** override any of the
  above.
- Two extra required contexts, `CodeQL` and `CodeRabbit`, on top of the
  ruleset's three. **`CodeRabbit` has never reported a conclusion on any PR
  here**, so it is permanently pending. Confirmed on PR #26: the REST merge API
  refused it as "pending", while GitHub's auto-merge landed the same PR as soon
  as its review threads were resolved. Auto-merge evaluates the ruleset; the
  REST API evaluates this layer. Anything merging through the API will stall.

`require_extra_approval_for_unattributed_changes` was turned off on the ruleset:
it demands an approval that a solo maintainer cannot give, because GitHub
forbids approving your own pull request. Re-enabling it will deadlock any PR
whose commits carry a `Co-Authored-By` trailer.

On the ruleset — the layer auto-merge actually evaluates — `CodeRabbit`, `label`
and `Scorecard analysis` are deliberately **not** required: an advisory review
and a labeling bot should not be able to wedge the repository shut. The classic
layer contradicts this by requiring `CodeRabbit` anyway, which is a
misconfiguration rather than an intent; it is harmless only because auto-merge
does not consult that layer.

## CI (`ci.yml`)

Runs on pushes to `main` and on pull requests. Matrix over Node 22 and 24 with
`fail-fast: false`; concurrency grouped per ref with `cancel-in-progress`.

Node 20 was dropped because the coverage threshold flags do not exist there. It
reached end-of-life in April 2026.

Each job runs `npm ci --ignore-scripts` → `npm run lint` → `npx prettier
--check .` → `npm run build` → `npm test` — the same sequence as
`npm run verify`, which the pre-push hook runs. The two are kept identical so a
green local run means a green CI run.

- **Format is a separate gate from lint.** `npm run lint` is `tsc --noEmit` and
  has no opinion about formatting. Unformatted Markdown fails CI as hard as
  unformatted TypeScript; `npm run format` fixes it.
- **`npm test` tests compiled output**, via `tsconfig.test.json` into
  `dist-test/`, catching module-resolution and emit problems a TypeScript-native
  runner would paper over.
- **`npm test` enforces coverage** at 80% lines, branches, and functions. Node
  exits non-zero below any of them, failing a required check.
- **`--ignore-scripts`** skips husky's `prepare`, which fails outside a git work
  tree.

Thresholds live in the `test` script in [`package.json`](../package.json); the
hook and CI both inherit them. Lowering them to make a PR pass is almost always
wrong — add the test.

## CodeQL (`codeql.yml`)

`javascript-typescript` with the `security-and-quality` suite, on pushes to
`main`, on PRs, and weekly on cron — the scheduled run catches new advisories
against unchanged code.

Gated on the repository being public, since uploading results requires Advanced
Security. If the repository goes private this job skips — and GitHub reports a
skipped required check as successful, so PRs would merge with no CodeQL scan at
all. Revisit the ruleset and security coverage if visibility ever changes.

## OpenSSF Scorecard (`scorecard.yml`)

Supply-chain posture, published weekly, on pushes to `main`, and on branch
protection changes. Same public-repository gate as CodeQL.

Pinned to an exact version (`ossf/scorecard-action@v2.4.4`) because Scorecard
penalizes unpinned dependencies. `persist-credentials: false` keeps the token
out of the git config, which it also checks.

## Dependabot

[`dependabot.yml`](../.github/dependabot.yml) watches npm and GitHub Actions
weekly, capped at five open PRs. Dev-dependency minor and patch updates are
grouped into one PR.

## Auto-merge

[`auto-merge.yml`](../.github/workflows/auto-merge.yml) arms GitHub's auto-merge
on every PR, release PRs included. The one exception is a **Dependabot major**,
which waits for a human.

Two things make this safe:

- **`--auto` arms a queue; it does not merge.** GitHub merges only once every
  required check passes, coverage thresholds included. Nothing bypasses the
  ruleset.
- **Verification happens before the push.** The
  [`pre-push` hook](../.husky/pre-push) runs the same `npm run verify` as CI.

This workflow runs on `pull_request_target`, so it executes with the base
branch's permissions and secrets even for a fork's PR. That is what lets it
merge, and what makes it dangerous. **It never checks out or executes PR code —
preserve that property in any edit.** Checking out the head ref and running it
would hand a fork the ability to merge to `main`.

## Labeler (`labeler.yml`)

Labels PRs by path per [`.github/labeler.yml`](../.github/labeler.yml):
`documentation`, `ci`, `dependencies`, `tests`, `source`. Also
`pull_request_target`, but it only needs `pull-requests: write` and never
touches PR content.

That permission does not include `issues: write`, which is what creating a
missing label requires — so a label in `labeler.yml` that does not exist on the
repository is not created automatically. Pre-create labels before referencing
them.

## Release (`cd.yml`, the `release` job)

**Every merge to `main` that carries a releasable commit becomes a release.**
There is no release PR and no separate tagging step to remember.

The ordering is the design. `cd.yml` works out the next version _before_ it
builds, because the version and the tag are compiled into the artifact; deploys;
verifies against the live site; and only then bumps the version on `main`, tags,
and publishes the GitHub release. A failed deploy cuts no release, so a tag
means "this ran in production and answered for itself", not "this merged".

[`scripts/next-version.mjs`](../scripts/next-version.mjs) decides the bump from
the commit subjects since the last tag:

| Commit                                                 | Bump           |
| ------------------------------------------------------ | -------------- |
| `!` suffix, or a `BREAKING CHANGE:` footer             | major          |
| `feat`                                                 | minor          |
| `fix`, `perf`, `revert`, `build`, `refactor`           | patch          |
| anything else (`docs`, `chore`, `ci`, `test`, `style`) | **no release** |

A docs-only or chore-only merge still deploys; it just does not cut a version,
because a number that increments for a README fix stops meaning anything.

**Squash merging means the PR title is the commit message**, and therefore the
thing that decides the version. Branch commit subjects survive only as body
bullets and are not parsed. A PR titled `docs:` produces no release even when it
contains a `fix:` commit. `ship.sh` rejects a non-conventional title up front for
this reason. If you expected a release and did not get one, check the merged
commit's subject on `main` first.

The version bump lands on `main` as a `chore(release):` commit pushed with the
default `GITHUB_TOKEN`. GitHub refuses to raise push events for that token, so
the bump does not trigger a second deploy — one merge stays one deploy.

Tagging the release fires [`release.yml`](../.github/workflows/release.yml),
which builds, signs and attaches the artifacts. See
[versioning.md](./versioning.md) for what the footer does with all of this.

Until 2026-09-17 this was release-please, which maintained an open release PR.
It was removed along with `release-please-config.json` and
`.release-please-manifest.json`: with CD cutting a release per deploy, a release
PR would bump to a version CD had already tagged.

`CHANGELOG.md` is in [`.prettierignore`](../.prettierignore) because its
generated formatting does not match Prettier's.

## Publishing

There is no npm publish workflow. CD tags releases and GitHub generates the
notes; nothing pushes to a registry. Publishing would need a new workflow
triggered on release, using a scoped npm token or trusted publishing.

## Running the CI checks locally

```bash
npm ci
npm run lint && npx prettier --check . && npm run build && npm test
```
