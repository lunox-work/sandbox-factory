# scripts/

## `ship.sh`

Takes working-tree changes from `main` to merged, unattended. Written for
coding agents: the agent supplies the branch, title and body up front, and the
script handles everything after that.

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
7. Wait for auto-merge, then return you to an up-to-date `main`.

Exit code 0 means it merged. Anything else leaves the PR open with a reason.

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
| `--no-wait`        | off                | Open the PR and exit; auto-merge still lands it             |
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
a conclusion on any PR in this repo, so anything evaluated against the classic
layer — notably a direct `PUT /pulls/{n}/merge` API call — blocks forever.
GitHub's own auto-merge goes through the ruleset, which is why PRs do land. The
script therefore waits for auto-merge rather than calling the merge API.

`--resolve` controls how:

- **`coderabbit`** (default) — posts `@coderabbitai resolve` and waits for it to
  resolve its own threads. If they do not clear within `SHIP_REVIEW_TIMEOUT`,
  the script stops and prints which file and line each one is on.
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

### Caveat

`@coderabbitai resolve` is CodeRabbit's documented command for resolving its own
threads, but the script does not assume it worked: it re-checks and falls back
to reporting if the threads are still open. If CodeRabbit ever stops honouring
it, `ship.sh` degrades to `--resolve manual` behaviour rather than hanging.
