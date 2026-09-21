# scripts/

| Script             | Does                                                         |
| ------------------ | ------------------------------------------------------------ |
| `ship.sh`          | Takes working-tree changes from `main` to merged, unattended |
| `rotate-token.sh`  | Rotates `AUTO_MERGE_TOKEN`, or the production app secrets    |
| `build-info.mjs`   | Resolves build provenance — see [versioning.md][versioning]  |
| `next-version.mjs` | Decides the release bump — see [ci.md][release]              |

[versioning]: ../docs/versioning.md
[release]: ../docs/ci.md#release-cdyml-the-release-job

## `ship.sh`

Written for coding agents: supply the title up front, and the script handles
everything after that.

```bash
./scripts/ship.sh --title "fix: reject a blank organization handle" --issue 42 --yes
```

1. Returns you to an up-to-date `main` if you are on a stale branch with
   nothing uncommitted.
2. Moves the changes onto a new branch (`main` is push-protected) and commits
   them with the title as the subject, rebased onto `origin/main` — the ruleset
   is strict, so a branch cut from a stale `main` cannot merge.
3. Runs `npm run verify` — the same gate CI runs.
4. Pushes and opens a PR with the template filled in.
5. Switches you back to `main`, then **detaches** and, in the background:
   waits for `Test (Node 22)`, `Test (Node 24)` and `Analyze`; saves CodeRabbit
   feedback to `.git/ship/pr-<n>.review.md` and asks it to resolve its threads;
   watches for auto-merge; deletes the branch locally and on the remote.

Steps 1–4 run in the foreground, so a bad title or a failing `verify` is an
immediate error. Then:

```
  ok PR #27 — https://github.com/lunox-work/sandbox-factory/pull/27
==> Watching in the background (pid 51234)
      log:    .git/ship/pr-27.log
  ok terminal is free — the PR merges on its own once green
  ok back on main — start the next change here
```

### For agents: the PR URL is the finish line

`ship.sh` returns 0 once the PR is **open**, not once it merges. Do not poll
afterwards — no `gh pr checks` loop, no `sleep`, no tailing the log. A ship
takes 10–15 minutes, nearly all of it waiting on CodeRabbit, and watching burns
context while the session looks stuck. Report the URL and stop.

If a later turn needs the outcome, ask once:

```bash
gh pr view 27 --json state --jq .state
```

`--foreground` is for the rare case where the merge is a precondition for work
in the same turn.

### Flags

| Flag               | Default            | Notes                                                       |
| ------------------ | ------------------ | ----------------------------------------------------------- |
| `--title <text>`   | **required**       | Conventional Commit subject. Becomes the squash commit.     |
| `--branch <name>`  | derived from title | e.g. `fix: reject blank titles` → `fix/reject-blank-titles` |
| `--body <text>`    | diffstat           | PR description                                              |
| `--type <t>`       | inferred           | `bug\|feature\|breaking\|docs\|internal`                    |
| `--issue <n>`      | —                  | Adds `Closes #n`                                            |
| `--coauthor <who>` | —                  | `Co-Authored-By` trailer as `Name <email>`                  |
| `--resolve <mode>` | `coderabbit`       | `coderabbit\|manual\|force` — see below                     |
| `--draft`          | off                | Opens a draft; CodeRabbit and auto-merge both skip drafts   |
| `--no-wait`        | off                | Open the PR and exit; do not watch at all                   |
| `--foreground`     | off                | Watch inline instead of detaching                           |
| `--yes` / `-y`     | off                | Skip the confirmation prompt (use this in automation)       |

| Environment           | Default | Notes                                         |
| --------------------- | ------- | --------------------------------------------- |
| `SHIP_CHECK_TIMEOUT`  | 1800s   | Waiting on required checks                    |
| `SHIP_REVIEW_TIMEOUT` | 1800s   | Waiting on CodeRabbit                         |
| `SHIP_MERGE_TIMEOUT`  | 600s    | Waiting on auto-merge                         |
| `SHIP_POLL`           | 20s     | Poll interval                                 |
| `SHIP_COAUTHOR`       | —       | Same as `--coauthor`, for every ship          |
| `SHIP_NO_AUTO_MAIN`   | —       | `1` skips the return to `main` at startup     |
| `SHIP_NO_SWEEP`       | —       | `1` leaves merged branches in place afterward |

### Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| 0    | Merged, detached, or opened with `--no-wait` / `--draft`     |
| 1    | Usage or precondition error — nothing was pushed             |
| 2    | `npm run verify` failed; changes are committed on the branch |
| 3    | A required check failed; PR left open                        |
| 4    | Timed out waiting                                            |
| 5    | Blocked on review threads or a merge conflict                |

### Review threads and `--resolve`

`main` has two protection layers; see
[docs/ci.md](../docs/ci.md#branch-protection). Two consequences shape this
script:

- **Unresolved threads block the merge**, and `--admin` does not override it.
  CodeRabbit leaves threads on most PRs, so an unattended script has to settle
  them.
- **The REST merge API is refused** on the permanently-pending `CodeRabbit`
  context, while auto-merge is not. The script waits for auto-merge and never
  calls the merge API.

`--resolve` controls how threads are settled:

- **`coderabbit`** (default) — posts `@coderabbitai resolve` and waits for it to
  resolve its own threads. **Slow** — about eight minutes on PR #26, hence the
  30-minute `SHIP_REVIEW_TIMEOUT`. If threads do not clear, the script stops
  and prints the file and line of each.
- **`manual`** — resolves nothing; stops and reports as soon as a thread
  appears.
- **`force`** — resolves every thread unread. Guarantees a merge and discards
  the feedback; on PR #25 that would have buried four real errors. Use it only
  after reading the feedback.

Both `coderabbit` and `force` close threads nobody has read, so the unresolved
comments are first written to `.git/ship/pr-<n>.review.md`. **Read it before the
next change** and fix what is real in a follow-up. No file means nothing was
unresolved.

**Zero unresolved threads is ambiguous** — "reviewed, found nothing" or "has not
posted yet". The script waits for evidence that a review happened (a review,
any thread, or the `CodeRabbit` check concluding) before trusting a zero count.
A PR with no findings may produce no signal at all, so after
`SHIP_REVIEW_TIMEOUT` it proceeds anyway. That is safe: auto-merge still gates
on the required checks, and late threads simply block the merge.

While waiting, the script keeps the branch current with `gh pr update-branch`
whenever `main` moves, so re-run checks overlap the review wait. A PR that
conflicts with `main` stops at once with exit code 5.

### Branches: where you are left, and what gets deleted

**You are left on `main`**, fast-forwarded, before the script detaches. The
pushed branch stays behind; the PR is the record of it. Otherwise the next
change would stack on an open PR, which `ship.sh` refuses (`has commits not in
main`) only after the edits are made. If something blocks the switch, it warns
and leaves you where you are.

**It also returns to `main` on the way in**, for the stale branch left by a
timed-out ship or a PR merged in the web UI. Only when there is nothing to lose:
a clean tree, no commits missing from `main`, and no open PR for the branch.
Under squash-merge a merged branch's commits are never ancestors of `main`, so
it asks GitHub and treats a `MERGED` PR as proof.

**On merge the branch is deleted locally and on the remote.** The remote delete
is explicit because `delete_branch_on_merge` does not reliably fire for
auto-merge under the Actions token. The child then sweeps branches left by
earlier runs, deleting one only when its PR reports `MERGED`. It leaves `main`,
the current branch, `release-please--*`, branches with no PR or an open one, and
any branch holding unpushed commits.

**The detached child never checks anything out** — it shares your working tree.
It is also launched from a snapshot under `.git/ship/`, not from
`scripts/ship.sh`: bash reads a script lazily by byte offset, so a checkout that
rewrites the tracked file corrupts a running child (PR #30). `.git/` is never
checked out.

### Co-author credit

Off by default. Pass `--coauthor "Name <email>"` or set `SHIP_COAUTHOR`. The
trailer is written into both the branch commit and the PR body — GitHub builds
the squash commit from the **PR title and body**, so only the PR body copy
survives the merge. GitHub renders a co-author avatar only when the email
belongs to a real account.

### What else it guards against

- **The PR title is the only commit message that survives** the squash, and
  `next-version.mjs` parses it. A non-conventional title is rejected up front
  rather than silently producing no release.
- **Everything in the working tree is committed**, so the script prints the file
  list, flagging untracked files, before it does.
- **Auto-merge is armed by the workflow.** The script nudges it only if it is
  somehow not armed.
- If CodeRabbit stops honouring `@coderabbitai resolve`, the script degrades to
  `--resolve manual` behaviour rather than hanging.

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
