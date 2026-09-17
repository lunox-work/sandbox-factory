# CI and automation

Eleven workflows in [`.github/workflows/`](../.github/workflows/), plus branch
protection on `main`.

The ones with a section below are the ones you interact with. The rest run
unattended and are named here so nothing is a surprise: `cd.yml` (deploy and
release — see [versioning.md](./versioning.md)), `release.yml` (signs and
attaches artifacts when a tag appears), `terraform.yml` (validates infra on
PRs and on `main`; plans on PRs only, with the read-only plan role),
`deploy-watchdog.yml` (daily: is production at `main`'s head?), `security-sweep.yml` (nightly), `codeql-autofix.yml` (asks CodeQL for
a fix on its own findings).

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

Each job runs `npm ci --ignore-scripts` → `npm run lint` → `npm run format:check`
→ `npm run build` → `npm test` — the same sequence as `npm run verify`, which
the pre-push hook runs. Keep them identical: `verify` is the gate you can run
locally, and a failure there is a failure here.

CI then does three things `verify` does not, so a green `verify` is necessary
but not sufficient: it runs against a **Postgres service container**, and it
asserts afterwards that the build recorded its commit and that the
database-backed tests actually ran rather than silently skipping.

- **Format is a separate gate from lint.** `npm run lint` is `tsc --noEmit` and
  has no opinion about formatting. Unformatted Markdown fails CI as hard as
  unformatted TypeScript; `npm run format` fixes it.
- **`npm test` tests compiled output**, via `tsconfig.test.json` into
  `dist-test/`, catching module-resolution and emit problems a TypeScript-native
  runner would paper over.
- **`npm test` enforces coverage.** Node exits non-zero below any threshold,
  failing a required check.
- **`--ignore-scripts`** skips husky's `prepare`, which fails outside a git work
  tree.

Thresholds are **per workspace**, set in each workspace's own `package.json`
`test` script — not the root one, which is only `turbo run test`. They are 90%
for the packages, 80% for `apps/api`, and `apps/web` runs Vitest without
thresholds. Lowering one to make a PR pass is almost always wrong — add the
test.

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
on every PR. The one exception is a **Dependabot major**, which waits for a
human.

It merges with the **`AUTO_MERGE_TOKEN`** secret, not the default
`GITHUB_TOKEN`, and that is the single most load-bearing fact about this
workflow. GitHub does not raise events for pushes made with the default token —
a guard against a workflow retriggering itself — so a merge performed with it
produces a `main` that CI and CD never observe. Deploys would then have to be
dispatched by hand. If the secret expires the workflow falls back to the default
token and says so in its log; rotate it with
[`scripts/rotate-token.sh`](../scripts/rotate-token.sh).

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

**Every merge to `main` that deploys and carries a releasable commit becomes a
release.** There is no release PR and no separate tagging step to remember.

The ordering is the design. `cd.yml` works out the next version _before_ it
builds, because the version and the tag are compiled into the artifact; deploys;
verifies against the live site; and only then tags the deployed commit and
publishes the GitHub release. A failed deploy cuts no release, so a tag means
"this ran in production and answered for itself", not "this merged".

[`scripts/next-version.mjs`](../scripts/next-version.mjs) decides the bump from
the commit subjects since the last tag:

| Commit                                                 | Bump           |
| ------------------------------------------------------ | -------------- |
| `!` suffix, or a `BREAKING CHANGE:` footer             | major          |
| `feat`                                                 | minor          |
| `fix`, `perf`, `revert`, `build`, `refactor`           | patch          |
| anything else (`docs`, `chore`, `ci`, `test`, `style`) | **no release** |

A chore-only merge still deploys; it just does not cut a version, because a
number that increments for a README fix stops meaning anything.

A **docs-only** merge does not even deploy: `cd.yml` has `paths-ignore` for
`**.md`, `docs/**` and `.github/ISSUE_TEMPLATE/**`, so the workflow never
fires. Editing only those paths produces no deploy and no release — which is
also why a docs fix cannot be used to force a redeploy.

**Squash merging means the PR title is the commit message**, and therefore the
thing that decides the version. Branch commit subjects survive only as body
bullets and are not parsed. A PR titled `docs:` produces no release even when it
contains a `fix:` commit. `ship.sh` rejects a non-conventional title up front for
this reason. If you expected a release and did not get one, check the merged
commit's subject on `main` first.

The tag is cut on the commit that was deployed, and nothing is pushed to `main`.
One release is therefore one sha: the footer's `1.2.3+abc1234`, the commit the
release page names, and the sha in the asset filenames and the provenance
attestation all agree, so a link from the footer lands on a page describing the
build the reader came from.

Nothing bumps `package.json`, which means it does not track the released
version — the tags do. The next version is computed from the last tag rather
than from the file. Treat `package.json` as the floor for a first release, not
as a record of what is live; `/version` and the footer answer that.

The release job then dispatches
[`release.yml`](../.github/workflows/release.yml), which builds, signs and
attaches the artifacts. It has to be dispatched: the tag is pushed with the
default `GITHUB_TOKEN`, and GitHub raises no `push` event for that, so
`release.yml`'s own tag trigger only fires for a tag pushed by a person. See
[versioning.md](./versioning.md) for what the footer does with all of this.

Until 2026-09-17 this was release-please, which maintained an open release PR.
It was removed along with `release-please-config.json` and
`.release-please-manifest.json`: with CD cutting a release per deploy, a release
PR would bump to a version CD had already tagged.

`CHANGELOG.md` is in [`.prettierignore`](../.prettierignore) — its formatting
came from release-please and does not match Prettier's. Nothing generates it
now; GitHub's release notes are the changelog, so the file is a historical
record frozen at 1.0.0.

### When a deploy goes wrong

Deploys queue rather than cancel (`concurrency: deploy-production`), so they
run in merge order and one stuck run holds up every later one. The deploy job
has `timeout-minutes: 20` for that reason — a healthy deploy is four to seven
minutes. GitHub keeps only one run waiting per group: a newer merge replaces
the one already queued, which is fine, because deploying the newer commit
includes the older.

A failed or cancelled deploy cuts no tag, and the next successful one picks the
version up: it counts commits since the last tag, so nothing is skipped. On
2026-09-17 production reported `1.1.0` while the newest tag was `1.0.0` for
exactly this reason — the deploy that would have tagged it hung.

To retry by hand: `gh workflow run cd.yml`. A dispatched run deploys but never
tags; only a push to `main` does.

## Publishing

There is no npm publish workflow. CD tags releases and GitHub generates the
notes; nothing pushes to a registry. Publishing would need a new workflow
triggered on release, using a scoped npm token or trusted publishing.

## Running the CI checks locally

```bash
npm ci
npm run lint && npx prettier --check . && npm run build && npm test
```
