# scripts/

| Script                   | Does                                                               |
| ------------------------ | ------------------------------------------------------------------ |
| `ship.sh`                | Verifies, opens a PR, waits for the merge, then cleans up          |
| `rotate-token.sh`        | Rotates `AUTO_MERGE_TOKEN`, or the production app secrets          |
| `graphify.sh`            | Builds and queries the local maintenance code graph                |
| `install-agent-tools.sh` | Installs the pinned Archify and Diagram Design skills and Graphify |
| `build-info.mjs`         | Resolves build provenance — see [versioning.md][versioning]        |
| `next-version.mjs`       | Decides the release bump — see [ci.md][release]                    |

[versioning]: ../docs/versioning.md
[release]: ../docs/ci.md#release-cdyml-the-release-job

## `ship.sh`

```sh
./scripts/ship.sh --title "fix: reject a blank organization handle" --issue 42 --yes
```

Moves changes onto a branch, commits, rebases a newly created branch onto
`origin/main`, runs `npm run verify`, pushes and opens (or reuses) a PR. It then
returns the checkout to `main` and waits in the foreground while GitHub runs CI
and auto-merges. Once the PR is merged it fast-forwards `main` to the merge and
deletes the branch locally and on origin. Exit 0 means **merged into main**,
not deployed. No detached process runs on your laptop.

GitHub owns CI on every push and auto-merge once the required checks pass; the
script only watches. CodeRabbit reviews, but its findings are advisory. See
[branch protection](../docs/ci.md#branch-protection).

The wait stops with exit 3 on what needs a new commit: a failed required check,
a conflict with `main`, or a closed PR. A branch behind `main` and pending checks
are GitHub's to resolve, so it keeps waiting. To fix, check out the branch,
commit, and re-run with `--branch <name>`: it pushes, reuses the PR and waits
again. After `SHIP_WAIT_TIMEOUT` seconds (default 5400) it gives up with exit 4,
leaving the PR open; `SHIP_POLL_INTERVAL` (default 30) sets how often it asks.

| Flag               | Purpose                                                        |
| ------------------ | -------------------------------------------------------------- |
| `--title <text>`   | Required Conventional Commit subject; becomes the squash title |
| `--branch <name>`  | Optional branch; otherwise derived from the title              |
| `--body <text>`    | Description; otherwise generated from the diff                 |
| `--type <type>`    | bug, feature, breaking, docs or internal; inferred by default  |
| `--issue <number>` | Adds Closes #number                                            |
| `--coauthor <who>` | Name and email in both commit and PR; also `SHIP_COAUTHOR`     |
| `--draft`          | Hold for inspection; no automatic merging; implies `--no-wait` |
| `--no-wait`        | Return once the PR is open; no wait or branch cleanup          |
| `--yes` / `-y`     | Skip the commit confirmation prompt                            |

`--resolve`, `--foreground` and internal watcher flags are removed and rejected.
No script resolves review threads or issues approval overrides.
Exit codes: 0 merged (opened, with `--draft` or `--no-wait`), 1 precondition/usage
failure, 2 local verification failure, 3 merge blocked or PR closed, 4 timed out.

A branch is deleted only when every commit on it reached the head GitHub merged,
so nothing committed after the push is lost; otherwise it is kept with a
warning. With `--no-wait`, local main is refreshed when the script returns, not
when the future merge happens; run `git pull --ff-only` before your next change.
If checkout or fast-forward fails, the script warns and preserves your work.

## `rotate-token.sh`

Two jobs: the GitHub token auto-merge uses, and the production app secrets.

```bash
./scripts/rotate-token.sh            # rotate AUTO_MERGE_TOKEN; prompts, echo off
./scripts/rotate-token.sh --check    # is the stored token still working?
./scripts/rotate-token.sh --secrets                        # every app secret
./scripts/rotate-token.sh --secrets --only DATABASE_URL    # just one
```

`--check` changes nothing, so it cannot be combined with `--secrets`.

### `AUTO_MERGE_TOKEN`

Why auto-merge needs its own token is in [ci.md](../docs/ci.md#auto-merge).
The token is a fine-grained PAT scoped to this repository, with **Contents**
and **Pull requests** read and write. Resource owner must be **lunox-work**,
not a personal account. If the org enforces PAT approval the token is inert
until an owner approves it, which the script reports as "cannot see the repo".

- **Minting is a browser step.** GitHub has no API for issuing a PAT. The script
  validates what you minted, stores it, and verifies the write.
- **Do not pass the token as an argument** — it lands in shell history and `ps`.
  Use no argument (prompts with echo off) or `-` for stdin:
  `op read "op://Private/gh-auto-merge/token" | ./scripts/rotate-token.sh -`
- **Prefer a GitHub App.** A personal token ties every deploy to one account and
  expires on a schedule someone has to remember. The script warns when it
  detects a personal token; the token works either way.

### `--secrets`: the production app secrets

Rotates every key of `app_secrets` in `infra/secrets.tf`, as `.env.production` holds them, — what the API reads through AWS
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
