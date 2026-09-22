#!/usr/bin/env bash
# ship.sh — verify, push, open a PR, return to main. GitHub handles the rest.

set -euo pipefail

BRANCH="" TITLE="" BODY="" TYPE="" ISSUE=""
ASSUME_YES=0 DRAFT=0

# Optional Co-Authored-By trailer; empty (the default) adds none.
COAUTHOR="${SHIP_COAUTHOR:-}"

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: ./scripts/ship.sh --title "fix: ..." --yes

Verifies, pushes, opens a PR and returns to main. GitHub handles review,
repairs and auto-merge. Exit 0 means the PR is open, not merged or deployed.

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
  --draft             Open as a draft; no repairs or auto-merge until ready.
  --no-wait           Accepted for compatibility; returning immediately is default.
  --yes, -y           Skip the confirmation prompt.
  -h, --help          This message.

Exit codes:
  0 PR opened   1 usage/precondition error   2 verify failed locally
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
    --draft)   DRAFT=1; shift ;;
    --no-wait) shift ;;
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

# Parse the whole function before checkout changes this script on disk.
finish_shipping() {
  if git checkout main >/dev/null 2>&1; then
    if git pull --ff-only --quiet; then
      ok "back on main — synced now, not after the future PR merge"
    else
      warn "back on main, but could not fast-forward; update it before starting new work"
    fi
  else
    warn "could not switch back to main — still on $BRANCH; PR remains open"
  fi
  if [[ "$DRAFT" -eq 1 ]]; then
    info "Draft PR: mark ready to start review: gh pr ready $PR_NUM"
  else
    info "GitHub owns CI, CodeRabbit repairs and gated auto-merge."
    info "A blocker leaves the PR open; inspect: gh pr view $PR_NUM"
  fi
  info "$PR_URL"
  exit 0
}
finish_shipping
