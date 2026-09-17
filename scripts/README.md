# scripts/

## `ship.sh`

Takes working-tree changes from `main` to merged, unattended. Written for
coding agents: the agent supplies the title up front, and the script handles
everything after that.

**It does not block.** Once the PR is open it detaches and watches in the
background, so the terminal — and an agent session — is free immediately.

```bash
./scripts/ship.sh --title "fix: reject blank todo titles" --issue 42 --yes
```

That will:

0. Return you to an up-to-date `main` first, if you are on a stale branch and
   have nothing uncommitted.
1. Move the changes off `main` onto a new branch (`main` is push-protected).
2. Commit them with the title as the subject, then rebase that commit onto
   `origin/main` if local `main` was behind — the ruleset is strict, so a
   branch cut from a stale `main` cannot merge until it is updated, and
   updating it re-runs every check.
3. Run `npm run verify` — the same gate CI runs.
4. Push and open a PR with the template filled in.
5. Wait for `Test (Node 22)`, `Test (Node 24)`, and `Analyze`.
6. Save any CodeRabbit feedback to `.git/ship/pr-<n>.review.md`, then ask
   CodeRabbit to resolve its own review threads.
7. Return you to an up-to-date `main`, then watch for auto-merge and delete the
   branch, locally and on the remote.

Steps 1–4 run in the foreground, so a bad title or a failing `verify` is an
immediate error. From step 5 it detaches:

```
  ok PR #27 — https://github.com/lunox-work/sandbox-factory/pull/27
==> Watching in the background (pid 51234)
      log:    .git/ship/pr-27.log
      follow: tail -f .git/ship/pr-27.log
  ok terminal is free — the PR merges on its own once green
  ok back on main — start the next change here
```

Pass `--foreground` to watch inline instead. Exit code 0 means it merged (or
detached successfully); anything else leaves the PR open with a reason.

### For agents: the PR URL is the finish line

`ship.sh` returns 0 once the PR is **open**, not once it merges. Everything
after that — checks, review threads, the merge, deleting the branch — happens
in the detached child.

So do not poll afterwards. No `gh pr checks` loop, no `sleep` and re-check, no
tailing the log. A ship takes 10–15 minutes, nearly all of it waiting on
CodeRabbit, and an agent that watches spends its context on unchanged status
output while the user waits on a session that looks stuck. Report the URL and
stop.

If a later turn needs the outcome, ask once:

```bash
gh pr view 27 --json state --jq .state
```

`--foreground` is for the rare case where the merge is a precondition for work
in the same turn. The next task usually starts from `main` either way.

### Branch cleanup

On merge the branch is deleted locally and on the remote. The remote delete is
deliberate rather than left to the repository's `delete_branch_on_merge`
setting: that setting does not reliably fire for a merge performed by
auto-merge under the Actions token, which is how every PR here lands, and
branches from earlier runs accumulated on the remote with it enabled.

A detached child never checks anything out — it shares a working tree with
whatever you are doing in it, minutes after handing the terminal back. It
deletes the merged branch, deletes the remote branch and prunes, all of which
move no files.

It then sweeps up branches left behind by earlier runs — the ones from a ship
that timed out, ran with `--no-wait`, or from a PR merged in the web UI.
Merged-ness cannot be read from the commit graph under squash-merge, so the
sweep asks GitHub and deletes a branch only when its PR reports `MERGED`. It
leaves alone anything it cannot confirm: `main`, the current branch,
`release-please--*`, branches with no PR or an open one, and any branch holding
commits that were never pushed. Set `SHIP_NO_SWEEP=1` to keep a stale branch.

### You are left on `main`

Before it detaches, the parent switches the working tree back to `main` and
fast-forwards it. The branch it just pushed is left behind deliberately: the
commit is on the remote and the PR is the record of it.

This is what lets the next change start cleanly. Otherwise you are standing on
a branch whose PR is still open, and the next change stacks on unmerged
work — which `ship.sh` then refuses (`has commits not in main`), after the
edits have already been made.

If something in the tree blocks the switch, it warns and leaves you where you
are; the PR is open and watched either way.

### It also returns to `main` on the way in

The switch above covers the normal path, but you can still end up on a stale
branch — an earlier ship that timed out, a PR merged in the web UI, a branch
checked out by hand. Starting a feature there stacks it on that branch, which
`ship.sh` then refuses after the edits are made.

So at startup it moves you to an up-to-date `main` first. It does this only
when there is nothing to lose, and requires all three:

- a clean tree — no uncommitted or untracked work
- no commits of its own that are not already on `main`
- not a branch whose PR is still open

The second one cannot be read from the commit graph. Squash-merge gives `main`
a new commit, so a merged branch's commits are never ancestors of it; asked
that way, work that _did_ land looks unmerged. It asks GitHub instead, and
treats a `MERGED` PR as proof the commits are on `main`.

Anything else is left alone: a branch with real unmerged commits, or any dirty
tree, falls through to the normal logic, which either ships it as-is or stops
and says why. Set `SHIP_NO_AUTO_MAIN=1` to skip the switch entirely.

### The child runs from a copy

The detached child is launched from a snapshot of the script under
`.git/ship/`, not from `scripts/ship.sh`.

bash reads a script lazily, by byte offset, as it runs. `scripts/ship.sh` is a
tracked file, so any checkout — including the switch back to `main` above —
rewrites those bytes underneath the running child, which then resumes at the
same offset in different text. On PR #30 the child logged nothing after that
point, never saw the merge and never cleaned up, while still sitting in its
poll loop. `.git/` is never checked out, so a copy there is immune. The child
removes it on exit.

### Flags

| Flag               | Default            | Notes                                                       |
| ------------------ | ------------------ | ----------------------------------------------------------- |
| `--title <text>`   | **required**       | Conventional Commit subject. Becomes the squash commit.     |
| `--branch <name>`  | derived from title | e.g. `fix: reject blank titles` → `fix/reject-blank-titles` |
| `--body <text>`    | diffstat           | PR description                                              |
| `--type <t>`       | inferred           | `bug\|feature\|breaking\|docs\|internal`                    |
| `--issue <n>`      | —                  | Adds `Closes #n`                                            |
| `--coauthor <who>` | —                  | `Co-Authored-By` trailer as `Name <email>` — see below      |
| `--resolve <mode>` | `coderabbit`       | `coderabbit\|manual\|force` — see below                     |
| `--draft`          | off                | Opens a draft; CodeRabbit and auto-merge both skip drafts   |
| `--no-wait`        | off                | Open the PR and exit; do not watch at all                   |
| `--foreground`     | off                | Watch inline instead of detaching                           |
| `--yes` / `-y`     | off                | Skip the confirmation prompt (use this in automation)       |

Timeouts are environment variables: `SHIP_CHECK_TIMEOUT` (1800s),
`SHIP_REVIEW_TIMEOUT` (1800s), `SHIP_MERGE_TIMEOUT` (600s), `SHIP_POLL` (20s).

### Co-author credit

Off by default. Pass `--coauthor "Name <email>"`, or set `SHIP_COAUTHOR` once
in your environment to credit every ship:

```bash
export SHIP_COAUTHOR="Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

The trailer is written twice — into the branch commit and into the PR body.
Both are needed. This repo merges with `--squash`, and GitHub builds the squash
commit on `main` from the **PR title and body**, discarding the branch commit's
message. A trailer placed only on the commit disappears at merge; the PR body
copy is the one that survives.

Note that GitHub only renders a co-author avatar when the email belongs to a
real account. `noreply@anthropic.com` does not, so the trailer is present in
`git log` but the commit list still shows one author.

Two more switch off behaviour rather than timing: `SHIP_NO_AUTO_MAIN=1` keeps
you on the current branch instead of returning to `main` at startup, and
`SHIP_NO_SWEEP=1` leaves merged branches in place after a ship.

### Rotating the application secrets

`--secrets` rotates the eight values in `.env.production` — the credentials the
API reads through AWS Secrets Manager.

```bash
./scripts/rotate-token.sh --secrets                        # ask about all eight
./scripts/rotate-token.sh --secrets --only DATABASE_URL    # ask about one
```

It asks for each key in turn and **skips any you leave blank**, so rotating one
credential does not mean re-pasting the other seven. For each key it shows a
redacted version of the current value and where in that provider's console the
replacement is minted.

Then, in order and each behind its own prompt:

1. **Rewrites `.env.production` in place.** Comments and section structure are
   preserved, so the file still diffs cleanly against `.env.example`. The
   previous file is kept as `.env.production.bak.<timestamp>` — covered by the
   existing `.env.*` rule in `.gitignore`, and worth deleting once the rotation
   is confirmed, because it holds live credentials.
2. **Validates** with `secrets-check.sh`, the same check the API applies at
   boot. A file that fails is never pushed.
3. **Pushes** to AWS Secrets Manager via `secrets-push.sh`, naming only the
   keys this run actually changed. The values you skipped are left alone in
   Secrets Manager rather than overwritten from your local file — which is what
   makes a partial rotation safe if `.env.production` has drifted from
   production for a key you did not touch.
4. **Restarts the API** with `--force-new-deployment`.

Step 4 is not optional busywork. The ECS agent reads Secrets Manager when a task
_starts_, so a running task keeps the values it booted with — until it restarts,
the rotation has happened everywhere except where it matters.

Answering no at any step stops there and prints the command to finish by hand.

### Rotating `BETTER_AUTH_SECRET` signs everyone out

It signs session tokens, so replacing it invalidates every existing session.
That is the point when rotating after a leak, and a surprise otherwise.

### Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| 0    | Merged (or opened, with `--no-wait` / `--draft`)             |
| 1    | Usage or precondition error — nothing was pushed             |
| 2    | `npm run verify` failed; changes are committed on the branch |
| 3    | A required check failed; PR left open                        |
| 4    | Timed out waiting                                            |
| 5    | Blocked on review threads or a merge conflict                |

### Why review threads matter here

`main` has two protection layers and both apply; see
[docs/ci.md](../docs/ci.md#branch-protection) for what each one requires. Two
consequences shape this script:

- **Unresolved threads block the merge**, and `enforce_admins` means `--admin`
  does not override it. CodeRabbit leaves threads on most PRs, so an unattended
  script has to settle them — hence the wait loop and `--resolve`.
- **Auto-merge evaluates the ruleset; the REST merge API evaluates the classic
  layer**, which additionally requires the permanently-pending `CodeRabbit`
  context. Confirmed on PR #26, where `PUT /pulls/{n}/merge` was refused while
  auto-merge landed the same PR. The script therefore waits for auto-merge and
  never calls the merge API.

`--resolve` controls how:

- **`coderabbit`** (default) — posts `@coderabbitai resolve` and waits for it to
  resolve its own threads. This works, but is **slow**: on PR #26 it took about
  eight minutes to reply "Action performed", which is why
  `SHIP_REVIEW_TIMEOUT` defaults to 30 minutes. If threads do not clear in that
  window the script stops and prints which file and line each one is on.
- **`manual`** — never resolves anything; stops and reports as soon as a thread
  appears.
- **`force`** — resolves every thread unread. Guarantees a merge, but discards
  the feedback. On PR #25 this would have silently buried four real factual
  errors that CodeRabbit had correctly found.

Prefer the default. Reach for `force` only when you have already read the
feedback and decided it does not apply.

Both `coderabbit` and `force` close threads that nobody has read, so before
either does, the unresolved comments are written to
`.git/ship/pr-<n>.review.md` — file, line, link and the comment itself. Read it
before the next change and fix what is real in a follow-up. No file means there
was nothing unresolved to save.

While it waits, the script also keeps the branch current: if `main` moves past
the PR, it calls `gh pr update-branch` straight away, in whichever loop it is
in, so the re-run of the checks overlaps the review wait instead of following
it. A PR that conflicts with `main` stops with exit code 5 at once — checks
never start on a conflicted PR, so there is nothing to wait for.

### Rules this encodes

Each of these is a way a PR can fail in this repo; the script handles them so
they do not have to be rediscovered:

- **`main` is push-protected**, so changes on `main` are moved to a branch
  first. An ordinary `checkout -b` carries uncommitted work across, leaving
  `main` untouched.
- **The PR title is the only commit message that survives** the squash, and
  next-version.mjs parses it. A non-conventional title is rejected up front
  rather than silently producing no release.
- **`npm run verify` is the real gate** — it runs before the push, so a failure
  is a clean error rather than a `pre-push` hook abort.
- **Everything in the working tree is committed**, so the script prints the file
  list, flagging untracked files, before it does.
- **Auto-merge covers every PR except a Dependabot major**, and the workflow
  arms it. The script nudges it only if it is somehow not armed.

### When there is nothing to resolve

Zero unresolved threads is ambiguous: it means either "CodeRabbit reviewed and
found nothing" or "CodeRabbit has not posted yet". Acting on the second would
let the script sail past a review that lands moments later.

So the script waits for positive evidence that a review happened — a CodeRabbit
review, any thread, or the `CodeRabbit` check reporting a conclusion — before
trusting a zero count.

On a PR with genuinely no findings there may be **no signal at all** (PR #21 is
one: no review, no threads, and the check never concludes). Nothing can be
polled for, so after `SHIP_REVIEW_TIMEOUT` the script proceeds anyway. That is
safe: auto-merge still gates on the required checks, and if threads do arrive
later they block the merge and the PR simply stays open.

### Caveat

`@coderabbitai resolve` works but is not instant, and the script does not assume
it succeeded: it re-checks and falls back to reporting if threads are still
open. If CodeRabbit ever stops honouring it, `ship.sh` degrades to
`--resolve manual` behaviour rather than hanging.

## `rotate-token.sh`

Replaces `AUTO_MERGE_TOKEN`, validating the new token before storing it and
confirming the write afterwards.

```bash
./scripts/rotate-token.sh            # prompts; nothing reaches shell history
./scripts/rotate-token.sh --check    # is the stored token still working?
```

`--check` changes nothing, so it cannot be combined with `--secrets`, which is
a write. The script rejects that pair rather than quietly honouring one of them.

### Why this secret exists

`auto-merge.yml` squash-merges with `AUTO_MERGE_TOKEN` rather than the default
`GITHUB_TOKEN`, because GitHub deliberately raises no events for pushes made
with the default token — a guard against a workflow retriggering itself. Both
`ci.yml` and `cd.yml` trigger on `push: branches: [main]`, so a merge performed
with the default token lands and **nothing observes it**.

That was the state of this repository until #35: every green check came from
the `pull_request` event, which made PRs look fully gated — and they were — while
no deploy ever ran. Production was only ever updated by hand.

So a dead token here does not fail loudly. It silently returns the repository to
having no continuous deployment, which is why `--check` exists and why the
workflow logs a warning on every fallback.

### Required permissions

A fine-grained PAT scoped to this repository:

| Permission    | Access         |
| ------------- | -------------- |
| Contents      | Read and write |
| Pull requests | Read and write |

Resource owner must be **lunox-work**, not a personal account. If the org
enforces PAT approval the token stays inert until an owner approves it, and
`rotate-token.sh` reports that as "cannot see the repo".

### Prefer a GitHub App

A personal token ties every automatic deploy to one account and expires on a
schedule someone has to remember. A GitHub App installation token does neither.
The script warns when it detects a personal token; the warning is advice, not
an error, and the token works either way.

### Minting is a browser step

GitHub has no API for issuing a PAT, so the script cannot create one. It covers
everything either side: checking what is stored, validating what you minted,
storing it, and verifying the result.

### Do not pass the token as an argument

It is accepted, because a caller that already holds the value should not be
forced through a prompt. But it lands in shell history and in `ps` output, so
the script warns whenever it is used from a terminal. Use no argument (prompts
with echo off) or `-` to read stdin:

```bash
op read "op://Private/gh-auto-merge/token" | ./scripts/rotate-token.sh -
```

### Exit codes

```
0  rotated, or --check passed        2  the new token is unusable
1  usage/precondition error          3  --check: stored token is bad
```

A non-zero exit from validation means nothing was changed — the previous token
is still in place.
