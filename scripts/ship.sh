#!/usr/bin/env bash
# ship.sh — verify, push, open a PR, wait for GitHub to merge it, then refresh
# main and delete the merged branch.
#
# AGENTS: by default exit 0 means MERGED into main. Exit 3 means something
# blocks the merge — a failing required check, a conflict, a closed PR. You own
# the PR until it merges: check out its branch, fix and commit, and re-run with
# `--branch <name>`, which pushes, reuses the PR and waits again. With --draft or
# --no-wait, exit 0 only means the PR is open; watch it yourself until
# `gh pr view <n> --json state` says MERGED. Only then report it shipped.
# Never bypass a check: no --no-verify, no admin merge.

set -euo pipefail

BRANCH="" TITLE="" BODY="" TYPE="" ISSUE=""
ASSUME_YES=0 DRAFT=0 WAIT=1

# How long to wait for the merge, and how often to ask GitHub.
WAIT_TIMEOUT="${SHIP_WAIT_TIMEOUT:-5400}"
POLL_INTERVAL="${SHIP_POLL_INTERVAL:-30}"

# Optional Co-Authored-By trailer; empty (the default) adds none.
COAUTHOR="${SHIP_COAUTHOR:-}"

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: ./scripts/ship.sh --title "fix: ..." --yes

Verifies, pushes, opens a PR, then waits while GitHub runs CI and
auto-merges it. Once merged, it returns to an up-to-date main and deletes
the branch locally and on origin. Exit 0 means merged into main (not yet
deployed); with --draft or --no-wait, exit 0 means the PR is open.

On a blocker (failing required check, conflict, closed PR) it stops with
exit 3, on main with the PR open. Fix on the branch and re-run with
--branch <name>; see the note at the top of this script.

Flags:
  --branch <name>     Branch to create. Default: derived from the title.
  --title <text>      PR title. REQUIRED. Must be a Conventional Commit
                      subject — it becomes the squash commit on main.
  --body <text>       PR description. Default: generated from the diff.
  --type <t>          Template checkbox: bug|feature|breaking|docs|internal.
                      Default: inferred from the title prefix.
  --issue <n>         Issue number for "Closes #n".
  --coauthor <who>    Add a Co-Authored-By trailer, as "Name <email>". Also
                      settable via SHIP_COAUTHOR. Default: none. The trailer
                      goes in both the commit and the PR body, because the
                      squash commit on main is built from the PR, not from
                      the branch commit.
  --draft             Open as a draft; no auto-merge until ready. Implies
                      --no-wait.
  --no-wait           Return to main once the PR is open; do not wait for
                      the merge or delete the branch.
  --yes, -y           Skip the confirmation prompt.
  -h, --help          This message.

Environment:
  SHIP_WAIT_TIMEOUT   Seconds to wait for the merge. Default: 5400.
  SHIP_POLL_INTERVAL  Seconds between checks on the PR. Default: 30.

Exit codes:
  0 merged (PR opened, with --draft/--no-wait)   1 usage/precondition error
  2 verify failed locally   3 merge blocked or PR closed   4 timed out waiting
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)  BRANCH="${2:-}"; shift 2 ;;
    --title)   TITLE="${2:-}"; shift 2 ;;
    --body)    BODY="${2:-}"; shift 2 ;;
    --type)    TYPE="${2:-}"; shift 2 ;;
    --issue)   ISSUE="${2:-}"; shift 2 ;;
    --coauthor) COAUTHOR="${2:-}"; shift 2 ;;
    --resolve|--foreground|--_child) die "$1 has been removed; GitHub owns review and merge" ;;
    --draft)   DRAFT=1; WAIT=0; shift ;;
    --no-wait) WAIT=0; shift ;;
    -y|--yes)  ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (try --help)" ;;
  esac
done

# --- preconditions ------------------------------------------------------------

command -v gh  >/dev/null || die "gh not found. brew install gh"
command -v git >/dev/null || die "git not found"
gh auth status >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

# git silently drops a trailer that is not "Name <email>", so reject it here.
if [[ -n "$COAUTHOR" && ! "$COAUTHOR" =~ ^.+\ \<[^\ ]+@[^\ ]+\>$ ]]; then
  die "--coauthor must look like \"Name <email>\" (got: $COAUTHOR)"
fi

cd "$(git rev-parse --show-toplevel)" || die "not inside a git repository"

[[ -n "$TITLE" ]] || die "--title is required. It becomes the squash commit on main."

# Squash-only: the PR title is the commit message, and scripts/next-version.mjs
# parses it for the bump. A non-conventional title silently releases nothing.
if ! [[ "$TITLE" =~ ^(feat|fix|docs|ci|chore|refactor|test|perf|build|style|revert)(\([a-z0-9._/-]+\))?!?:\ .+ ]]; then
  die "title must be a Conventional Commit, e.g. 'fix: ...' or 'feat(api)!: ...'
   got: $TITLE
   Squash-merge means this title is the commit message CD reads to version."
fi

if [[ -n "$ISSUE" && ! "$ISSUE" =~ ^[0-9]+$ ]]; then
  die "--issue must be a number (got: $ISSUE)"
fi

[[ "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]]  || die "SHIP_WAIT_TIMEOUT must be whole seconds (got: $WAIT_TIMEOUT)"
[[ "$POLL_INTERVAL" =~ ^[0-9]+$ ]] || die "SHIP_POLL_INTERVAL must be whole seconds (got: $POLL_INTERVAL)"

# --- work out the branch ------------------------------------------------------

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[a-z]+(\([^)]*\))?!?:[[:space:]]*//' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' \
    | cut -c1-48 | sed -E 's/-+$//'
}

if [[ -z "$BRANCH" ]]; then
  prefix="${TITLE%%:*}"; prefix="${prefix%%(*}"; prefix="${prefix%!}"
  case "$prefix" in
    feat) kind=feat ;; fix) kind=fix ;; docs) kind=docs ;; ci|build) kind=ci ;;
    *) kind=chore ;;
  esac
  BRANCH="$kind/$(slugify "$TITLE")"
fi
[[ "$BRANCH" =~ ^[a-z0-9._/-]+$ ]] || die "invalid branch name: $BRANCH"
[[ "$BRANCH" != "main" ]] || die "refusing to use 'main' as the working branch"

# --- inspect the working tree -------------------------------------------------

CURRENT="$(git rev-parse --abbrev-ref HEAD)"

# Switch to an up-to-date `main` when the current branch is disposable: a clean
# tree, and either no commits of its own or a MERGED PR (an open PR is the
# --branch re-ship path and is left alone). Squash-merge means a merged branch
# is never an ancestor of main, so `merge-base --is-ancestor` misreports landed
# work; ask GitHub, as the sweep does. Without this the next change stacks on a
# stale branch and the guard below refuses it after the edits are made.
if [[ "$CURRENT" != "main" && "${SHIP_NO_AUTO_MAIN:-0}" != "1" ]] \
   && git diff --quiet && git diff --cached --quiet \
   && [[ -z "$(git ls-files --others --exclude-standard)" ]]; then

  git fetch origin --quiet >/dev/null 2>&1 || true

  disposable=0
  if git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    disposable=1   # no commits of its own
  else
    pr_state="$(gh pr list --head "$CURRENT" --state all --limit 1 \
      --json state --jq '.[0].state // empty' 2>/dev/null || echo "")"
    [[ "$pr_state" == "MERGED" ]] && disposable=1
  fi

  if [[ "$disposable" -eq 1 ]]; then
    if git checkout main >/dev/null 2>&1; then
      git pull --ff-only --quiet >/dev/null 2>&1 || true
      ok "switched from $CURRENT to an up-to-date main"
      CURRENT="main"
    fi
  fi
fi

# Branching off a feature branch would sweep its commits into the PR. Passing
# --branch for the branch you are already on is the deliberate opt-in: ship it
# as-is, its own commits included. Any other --branch still cuts a new branch
# from here, which is the case this refuses.
if [[ "$CURRENT" != "main" && "$BRANCH" != "$CURRENT" ]] \
   && ! git diff --quiet --exit-code; then
  if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    die "on '$CURRENT', which has commits not in main.
   Creating a branch here would include them in the PR.
   Switch to main first, or pass --branch $CURRENT to ship this branch as-is."
  fi
fi
git diff --quiet && git diff --cached --quiet && HAS_CHANGES=0 || HAS_CHANGES=1
UNTRACKED="$(git ls-files --others --exclude-standard)"
[[ -n "$UNTRACKED" ]] && HAS_CHANGES=1

if [[ "$HAS_CHANGES" -eq 0 ]]; then
  if [[ "$CURRENT" == "main" ]]; then
    die "no changes to ship (working tree clean, on main)"
  fi
  info "No uncommitted changes; shipping existing commits on $CURRENT"
  BRANCH="$CURRENT"
  MODE="existing"
elif [[ "$BRANCH" == "$CURRENT" ]]; then
  # Already on the branch being shipped: commit here. Creating it would fail,
  # and there is nowhere to move the changes to.
  MODE="amend"
else
  MODE="new"
fi

# Changes sitting on main must move to a branch — main is push-protected.
case "$MODE" in
  new)    info "Changes detected on $CURRENT → moving to $BRANCH" ;;
  amend)  info "Changes detected on $BRANCH → committing here" ;;
  *)      info "Branch $BRANCH" ;;
esac

# --- confirm ------------------------------------------------------------------

# Everything in the tree gets committed; show it so a stray untracked file
# does not ride along unnoticed.
if [[ "$MODE" == "new" || "$MODE" == "amend" ]]; then
  echo
  echo "  Files to be committed:"
  git status --short | sed 's/^/    /'
  if [[ -n "$UNTRACKED" ]]; then
    echo
    warn "includes untracked file(s):"
    printf '%s\n' "$UNTRACKED" | sed 's/^/    + /' >&2
  fi
fi

if [[ "$ASSUME_YES" -eq 0 ]]; then
  echo
  echo "  branch : $BRANCH"
  echo "  title  : $TITLE"
  [[ "$DRAFT" -eq 1 ]] && echo "  draft  : yes (no auto-merge)"
  echo
  printf 'Ship it? [y/N] '
  read -r reply </dev/tty || reply=""
  [[ "$reply" =~ ^[Yy] ]] || { echo "aborted"; exit 0; }
fi

# --- move changes onto a branch ----------------------------------------------

if [[ "$MODE" == "new" || "$MODE" == "amend" ]]; then
  if [[ "$MODE" == "new" ]]; then
    if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
      die "branch $BRANCH already exists. Pass a different --branch."
    fi
    # Uncommitted changes follow `checkout -b` across, leaving `main` untouched.
    git checkout -b "$BRANCH" >/dev/null 2>&1 || die "could not create $BRANCH"
    ok "created $BRANCH"
  fi

  git add -A
  # Separate -m paragraphs: git only recognises a trailer in its own block.
  COMMIT_ARGS=(-m "$TITLE")
  [[ -n "$ISSUE" ]]    && COMMIT_ARGS+=(-m "Closes #$ISSUE")
  [[ -n "$COAUTHOR" ]] && COMMIT_ARGS+=(-m "Co-Authored-By: $COAUTHOR")

  git commit -q "${COMMIT_ARGS[@]}" || die "commit failed"
  ok "committed"
fi

# --- start from the real main -------------------------------------------------
# Local `main` may be stale. A branch cut from it opens BEHIND, and the strict
# ruleset blocks auto-merge until an update re-runs every check (PR #49).
# Only for a branch this run just created: it is unpushed, so rewriting it is
# free. The GitHub controller updates existing branches instead.
if [[ "$MODE" == "new" ]]; then
  if git fetch origin main --quiet >/dev/null 2>&1; then
    if ! git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
      if git rebase origin/main >/dev/null 2>&1; then
        ok "rebased onto origin/main (local main was behind)"
      else
        git rebase --abort >/dev/null 2>&1 || true
        warn "could not rebase onto origin/main cleanly — shipping as-is;"
        warn "GitHub will report the conflict on the PR"
      fi
    fi
  else
    warn "could not fetch origin/main — shipping from local main as-is"
  fi
fi

# --- verify before pushing ----------------------------------------------------
# The pre-push hook runs this too; failing here gives a clean error instead of
# a hook abort mid-push.

info "Running npm run verify (this is the gate — CI runs the same thing)"
VERIFY_LOG="$(mktemp "${TMPDIR:-/tmp}/ship-verify.XXXXXX")"
if ! npm run verify >"$VERIFY_LOG" 2>&1; then
  echo
  tail -30 "$VERIFY_LOG" >&2
  echo
  warn "verify failed — full log: $VERIFY_LOG"
  warn "Changes are committed on $BRANCH. Fix, commit, and re-run."
  exit 2
fi
rm -f "$VERIFY_LOG"
ok "verify passed"

# --- push ---------------------------------------------------------------------

info "Pushing $BRANCH"
git push -u origin "$BRANCH" >/dev/null 2>&1 || die "push failed"
ok "pushed"

# --- build the PR body --------------------------------------------------------

if [[ -z "$TYPE" ]]; then
  case "${TITLE%%:*}" in
    feat*) TYPE=feature ;; fix*) TYPE=bug ;; docs*) TYPE=docs ;;
    *) TYPE=internal ;;
  esac
fi
[[ "$TITLE" == *"!:"* ]] && TYPE=breaking

check() { [[ "$TYPE" == "$1" ]] && echo "[x]" || echo "[ ]"; }

if [[ -z "$BODY" ]]; then
  BODY="$(git diff --stat origin/main...HEAD | tail -1 | sed 's/^ *//')"
  BODY="Changes: $BODY"
fi

CLOSES=""
[[ -n "$ISSUE" ]] && CLOSES="

Closes #$ISSUE"

# GitHub builds the squash commit from the PR body, so a trailer only on the
# branch commit is lost at merge.
CREDIT=""
[[ -n "$COAUTHOR" ]] && CREDIT="

Co-Authored-By: $COAUTHOR"

PR_BODY="## What does this change?

${BODY}${CLOSES}

## Type of change

- $(check bug) Bug fix
- $(check feature) New feature
- $(check breaking) Breaking change
- $(check docs) Documentation
- $(check internal) Internal / refactor

## How was this tested?

\`npm run verify\` passes locally (lint, format, build, test + coverage).

## Checklist

- [x] I have read [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md)
- [x] \`npm run verify\` passes locally
- [x] This PR is one logical change

🤖 Opened by scripts/ship.sh${CREDIT}"

# --- open the PR --------------------------------------------------------------

info "Opening pull request"
PR_ARGS=(--base main --head "$BRANCH" --title "$TITLE" --body "$PR_BODY")
[[ "$DRAFT" -eq 1 ]] && PR_ARGS+=(--draft)

PR_URL="$(gh pr list --base main --head "$BRANCH" --state open --json url --jq '.[0].url // empty')" || die "could not look up existing PR"
if [[ -z "$PR_URL" ]]; then
  PR_URL="$(gh pr create "${PR_ARGS[@]}")" || die "gh pr create failed"
fi
PR_NUM="${PR_URL##*/}"
ok "PR #$PR_NUM — $PR_URL"

# Parse every function before checkout changes this script on disk.

# $1 is the line to print once main is current.
return_to_main() {
  if ! git checkout main >/dev/null 2>&1; then
    warn "could not switch back to main — still on $BRANCH"
    return 1
  fi
  if git pull --ff-only --quiet >/dev/null 2>&1; then
    ok "$1"
  else
    warn "back on main, but could not fast-forward; update it before starting new work"
  fi
}

# Poll until GitHub merges the PR. BEHIND and pending checks are GitHub's to
# resolve, so keep waiting; only what needs a new commit stops the wait.
# Sets MERGED_HEAD to the head commit GitHub merged.
MERGED_HEAD=""
wait_for_merge() {
  local deadline=$((SECONDS + WAIT_TIMEOUT)) view state merge oid failing last=""
  info "Waiting for PR #$PR_NUM to merge (up to $((WAIT_TIMEOUT / 60)) min)"
  while :; do
    if view="$(gh pr view "$PR_NUM" --json state,mergeStateStatus,headRefOid \
        --jq '[.state, .mergeStateStatus, .headRefOid] | join(" ")' 2>/dev/null)"; then
      read -r state merge oid <<<"$view"
      case "$state" in
        MERGED) MERGED_HEAD="$oid"; ok "PR #$PR_NUM merged into main"; return 0 ;;
        CLOSED) warn "PR #$PR_NUM was closed without merging"; return 3 ;;
      esac
      [[ "$merge" == "DIRTY" ]] && { warn "PR #$PR_NUM conflicts with main"; return 3; }
      # Only a required check blocks auto-merge; the others are advisory.
      failing="$(gh pr checks "$PR_NUM" --required --json name,bucket \
        --jq '[.[] | select(.bucket == "fail") | .name] | join(", ")' 2>/dev/null || true)"
      if [[ -n "$failing" ]]; then
        warn "required check failed on PR #$PR_NUM: $failing"
        return 3
      fi
      if [[ "$merge" != "$last" ]]; then
        info "PR #$PR_NUM: $(printf '%s' "$merge" | tr '[:upper:]' '[:lower:]')"
        last="$merge"
      fi
    fi
    if (( SECONDS >= deadline )); then
      warn "PR #$PR_NUM still open after $((WAIT_TIMEOUT / 60)) min"
      return 4
    fi
    sleep "$POLL_INTERVAL"
  done
}

# Delete a branch only when every commit on it reached the merged head, so
# nothing committed after the push is lost. Squash-merge means `git branch -d`
# never sees the branch as merged, hence -D behind that check. A branch that
# autofix pushed to is behind the merged head locally, which is still safe.
delete_merged_branch() {
  local tip remote_tip
  if [[ "$(git rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]]; then
    warn "still on $BRANCH; kept it"
    return
  fi
  # GitHub may have deleted the branch already; the PR ref keeps the head.
  git fetch --quiet origin "refs/pull/$PR_NUM/head" >/dev/null 2>&1 || true

  tip="$(git rev-parse --verify --quiet "refs/heads/$BRANCH" || true)"
  if [[ -n "$tip" ]]; then
    if git merge-base --is-ancestor "$tip" "$MERGED_HEAD" 2>/dev/null; then
      git branch -D "$BRANCH" >/dev/null && ok "deleted local $BRANCH"
    else
      warn "local $BRANCH has commits the merged PR does not; kept it"
    fi
  fi

  remote_tip="$(git ls-remote --heads origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1)"
  if [[ -z "$remote_tip" ]]; then
    ok "origin/$BRANCH already deleted"
  elif [[ "$remote_tip" == "$MERGED_HEAD" ]]; then
    if git push --quiet origin --delete "$BRANCH" >/dev/null 2>&1; then
      ok "deleted origin/$BRANCH"
    else
      warn "could not delete origin/$BRANCH"
    fi
  else
    warn "origin/$BRANCH moved past the merged head; kept it"
  fi
  git fetch --quiet --prune origin >/dev/null 2>&1 || true
}

finish_shipping() {
  local rc=0
  if [[ "$WAIT" -eq 0 ]]; then
    return_to_main "back on main — synced now, not after the future PR merge" || true
    if [[ "$DRAFT" -eq 1 ]]; then
      info "Draft PR: mark ready to start review: gh pr ready $PR_NUM"
    else
      info "GitHub owns CI and auto-merge."
      info "A blocker leaves the PR open; inspect: gh pr view $PR_NUM"
      info "Agents: monitor PR #$PR_NUM and resolve what blocks it until it merges into main."
    fi
    info "$PR_URL"
    exit 0
  fi

  # Wait from main: the branch is pushed, and a fix starts from a checkout.
  return_to_main "back on main while GitHub runs CI" || true
  wait_for_merge || rc=$?
  case "$rc" in
    0)
      return_to_main "main is at the merge" || true
      delete_merged_branch
      info "Shipped: PR #$PR_NUM is on main"
      ;;
    3)
      info "Fix it on the branch, then re-ship:"
      info "  git checkout $BRANCH   # commit the fix"
      info "  ./scripts/ship.sh --branch $BRANCH --title \"$TITLE\" --yes"
      ;;
    *)
      info "Still open; re-run from $BRANCH to keep waiting, or: gh pr view $PR_NUM"
      ;;
  esac
  info "$PR_URL"
  exit "$rc"
}
finish_shipping
