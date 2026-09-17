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

1. Move the changes off `main` onto a new branch (`main` is push-protected).
2. Commit them with the title as the subject.
3. Run `npm run verify` — the same gate CI runs.
4. Push and open a PR with the template filled in.
5. Wait for `Test (Node 22)`, `Test (Node 24)`, and `Analyze`.
6. Ask CodeRabbit to resolve its own review threads.
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
| `--resolve <mode>` | `coderabbit`       | `coderabbit\|manual\|force` — see below                     |
| `--draft`          | off                | Opens a draft; CodeRabbit and auto-merge both skip drafts   |
| `--no-wait`        | off                | Open the PR and exit; do not watch at all                   |
| `--foreground`     | off                | Watch inline instead of detaching                           |
| `--yes` / `-y`     | off                | Skip the confirmation prompt (use this in automation)       |

Timeouts are environment variables: `SHIP_CHECK_TIMEOUT` (1800s),
`SHIP_REVIEW_TIMEOUT` (900s), `SHIP_MERGE_TIMEOUT` (600s), `SHIP_POLL` (20s).

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

`main` has **two** protection layers, and only one is documented in
[docs/ci.md](../docs/ci.md):

- the `main protection` **ruleset** — required checks, squash-only, no
  force-push;
- a **classic branch protection** with `required_conversation_resolution: true`
  and `enforce_admins: true`.

The second one is the one that bites, in two ways. Any unresolved review thread
blocks the merge, and because `enforce_admins` is on, `--admin` does not
override it. CodeRabbit leaves threads on most PRs, so an unattended script has
to deal with them.

The two layers also require **different** checks. The ruleset requires
`Test (Node 22)`, `Test (Node 24)` and `Analyze`; the classic layer additionally
requires `CodeQL` and `CodeRabbit`. The `CodeRabbit` context has never reported
a conclusion on any PR in this repo, so it is permanently pending.

This was confirmed on PR #26: with `CodeRabbit` still pending, a direct
`PUT /pulls/{n}/merge` was refused, while GitHub's own auto-merge landed the PR
as soon as the threads were resolved. **Auto-merge evaluates the ruleset; the
REST merge API evaluates the classic layer.** The script therefore waits for
auto-merge and never calls the merge API.

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

### Rules this encodes

Each of these is a way a PR can fail in this repo; the script handles them so
they do not have to be rediscovered:

- **`main` is push-protected**, so changes on `main` are moved to a branch
  first. An ordinary `checkout -b` carries uncommitted work across, leaving
  `main` untouched.
- **The PR title is the only commit message that survives** the squash, and
  release-please parses it. A non-conventional title is rejected up front
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
