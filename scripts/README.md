# scripts/

| Script             | Does                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `ship.sh`          | Verifies, opens a PR and returns to main; GitHub owns review/merge |
| `rotate-token.sh`  | Rotates `AUTO_MERGE_TOKEN`, or the production app secrets          |
| `build-info.mjs`   | Resolves build provenance — see [versioning.md][versioning]        |
| `next-version.mjs` | Decides the release bump — see [ci.md][release]                    |

[versioning]: ../docs/versioning.md
[release]: ../docs/ci.md#release-cdyml-the-release-job

## `ship.sh`

```sh
./scripts/ship.sh --title "fix: reject a blank organization handle" --issue 42 --yes
```

Moves changes onto a branch, commits, rebases a newly created branch onto
`origin/main`, runs `npm run verify`, pushes and opens (or reuses) a PR. It then
returns the checkout to `main`, including for drafts. Exit 0 means **PR open**,
not merged or deployed. No detached process runs on your laptop.

GitHub owns the rest: CI and CodeRabbit review, up to three repair requests,
fresh checks/review after every push, and auto-merge only after the required
`Review gate` succeeds. Repairs that time out or cannot be made safely leave
the PR blocked. See [the gate policy](../docs/ci.md#review-and-repair-gate).

| Flag               | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `--title <text>`   | Required Conventional Commit subject; becomes the squash title |
| `--branch <name>`  | Optional branch; otherwise derived from the title              |
| `--body <text>`    | Description; otherwise generated from the diff                 |
| `--type <type>`    | bug, feature, breaking, docs or internal; inferred by default  |
| `--issue <number>` | Adds Closes #number                                            |
| `--coauthor <who>` | Name and email in both commit and PR; also `SHIP_COAUTHOR`     |
| `--draft`          | Hold for inspection; no automatic fixes or merging until ready |
| `--no-wait`        | Compatibility alias for the default behavior                   |
| `--yes` / `-y`     | Skip the commit confirmation prompt                            |

`--resolve`, `--foreground` and internal watcher flags are removed and rejected.
No script resolves review threads or issues approval overrides.
Exit codes: 0 opened, 1 precondition/usage failure, 2 local verification failure.

Local main is refreshed **when the script returns**, not when the future merge
happens. Run `git pull --ff-only` before your next change. GitHub deletes merged
remote branches; local feature branches remain as recoverable references.
If checkout or fast-forward fails, the script warns and preserves your work.

Policy changes (workflows, scripts, dependency/test configuration, infra) need
an explicit human maintainer acknowledgement of the latest SHA. The gate posts
the exact command on the PR. That acknowledgement does not bypass CI or review.
Dependabot majors and forks are not automatically merged.

## `rotate-token.sh`

Two jobs: the GitHub token auto-merge uses, and the production app secrets.

```bash
./scripts/rotate-token.sh            # rotate AUTO_MERGE_TOKEN; prompts, echo off
./scripts/rotate-token.sh --check    # is the stored token still working?
./scripts/rotate-token.sh --secrets                        # app secrets, all eleven
./scripts/rotate-token.sh --secrets --only DATABASE_URL    # just one
```

`--check` changes nothing, so it cannot be combined with `--secrets`.

### `AUTO_MERGE_TOKEN`

`auto-merge.yml` merges with this token rather than the default `GITHUB_TOKEN`,
because GitHub raises no events for pushes made with the default token. `ci.yml`
and `cd.yml` trigger on `push` to `main`, so a merge performed with the default
token lands and **nothing deploys**.

A dead token does not fail loudly — it silently returns the repository to having
no continuous deployment. That is why `--check` exists and why the workflow logs
a warning on every fallback.

The token is a fine-grained PAT scoped to this repository, with **Contents** and
**Pull requests** read and write. Resource owner must be **lunox-work**, not a
personal account. If the org enforces PAT approval the token is inert until an
owner approves it, which the script reports as "cannot see the repo".

- **Minting is a browser step.** GitHub has no API for issuing a PAT. The script
  validates what you minted, stores it, and verifies the write.
- **Do not pass the token as an argument** — it lands in shell history and `ps`.
  Use no argument (prompts with echo off) or `-` for stdin:
  `op read "op://Private/gh-auto-merge/token" | ./scripts/rotate-token.sh -`
- **Prefer a GitHub App.** A personal token ties every deploy to one account and
  expires on a schedule someone has to remember. The script warns when it
  detects a personal token; the token works either way.

### `--secrets`: the production app secrets

Rotates the eleven values in `.env.production` — what the API reads through AWS
Secrets Manager. It asks for each key in turn and **skips any you leave blank**,
showing a redacted current value and where that provider mints the replacement.

Then, each step behind its own prompt:

1. **Rewrites `.env.production` in place**, preserving comments and structure.
   The previous file is kept as `.env.production.bak.<timestamp>` — gitignored,
   but delete it once the rotation is confirmed; it holds live credentials.
2. **Validates** with `secrets-check.sh`, the same check the API applies at
   boot. A file that fails is never pushed.
3. **Pushes** via `secrets-push.sh`, naming only the keys this run changed. Keys
   you skipped are left alone in Secrets Manager, which keeps a partial rotation
   safe if your local file has drifted.
4. **Restarts the API** with `--force-new-deployment`. Not optional: ECS reads
   Secrets Manager when a task _starts_, so a running task keeps its old values.

Answering no at any step stops there and prints the command to finish by hand.

**Rotating `BETTER_AUTH_SECRET` signs everyone out** — it signs session tokens.

### Exit codes

| Code | Meaning                            |
| ---- | ---------------------------------- |
| 0    | Rotated, or `--check` passed       |
| 1    | Usage or precondition error        |
| 2    | The new token is unusable          |
| 3    | `--check`: the stored token is bad |

A non-zero exit from validation means nothing was changed.
