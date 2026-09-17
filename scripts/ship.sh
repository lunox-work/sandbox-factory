#!/usr/bin/env bash
#
# ship.sh — take working-tree changes from `main` to merged, unattended.
#
# Built for coding agents. The agent supplies the branch, title and body up
# front; the script then moves the changes off `main`, verifies, pushes, opens
# the PR, and babysits it until it merges. Nothing else is asked along the way.
#
#   ./scripts/ship.sh --title "fix: reject blank titles" \
#                     --body "Closes #42" \
#                     --type fix
#
# FIRE AND FORGET — this is the part agents get wrong.
#
# The script returns 0 as soon as the PR is *open*, having detached a child to
# watch it merge. The PR URL on stdout is the finish line: the merge, the
# review threads and the branch cleanup all complete without the caller.
#
# So do not poll afterwards — no `gh pr checks` loop, no `sleep` and re-check,
# no tailing the log. A ship takes 10-15 minutes, nearly all of it waiting on
# CodeRabbit, and an agent that watches burns its context on unchanged status
# output while the user waits. Print the URL and move on. To learn the outcome
# in a later turn, ask once: `gh pr view <n> --json state --jq .state`.
#
# --foreground opts back in, for the rare case where the merge is a
# precondition for the very next thing you do.
#
# See scripts/README.md for the full flag list and the repo rules this encodes.

set -euo pipefail

REPO="lunox-work/sandbox-factory"
REQUIRED_CHECKS=("Test (Node 22)" "Test (Node 24)" "Analyze")

# --- how long to wait ---------------------------------------------------------
# Checks take ~2-4 min. CodeRabbit posts a few minutes after that.
CHECK_TIMEOUT=${SHIP_CHECK_TIMEOUT:-1800}   # 30 min for required checks
# CodeRabbit's `resolve` took ~8 min on PR #26; allow generous headroom.
REVIEW_TIMEOUT=${SHIP_REVIEW_TIMEOUT:-1800} # 30 min for CodeRabbit to review+resolve
MERGE_TIMEOUT=${SHIP_MERGE_TIMEOUT:-600}    # 10 min for auto-merge to fire
POLL=${SHIP_POLL:-20}

BRANCH="" TITLE="" BODY="" TYPE="" ISSUE=""
ASSUME_YES=0 NO_WAIT=0 DRAFT=0 RESOLVE_MODE="coderabbit"
FOREGROUND=0 IS_CHILD=0

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }

usage() {
  # Through the fire-and-forget note, which is the thing a caller most needs to
  # read. Keep this range in step with the header above.
  sed -n '2,27p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Flags:
  --branch <name>     Branch to create. Default: derived from the title.
  --title <text>      PR title. REQUIRED. Must be a Conventional Commit
                      subject — it becomes the squash commit on main.
  --body <text>       PR description. Default: generated from the diff.
  --type <t>          Template checkbox: bug|feature|breaking|docs|internal.
                      Default: inferred from the title prefix.
  --issue <n>         Issue number for "Closes #n".
  --resolve <mode>    Review threads: coderabbit (ask it to resolve its own,
                      default) | manual (stop and report) | force (resolve
                      unread — discards feedback).
  --draft             Open as a draft. Skips CodeRabbit and auto-merge.
  --no-wait           Open the PR and exit without watching it at all.
  --foreground        Watch in this terminal instead of detaching.
  --yes, -y           Skip the confirmation prompt.
  -h, --help          This message.

Exit codes:
  0 merged (or opened with --no-wait/--draft)   3 checks failed
  1 usage/precondition error                    4 timed out waiting
  2 verify failed locally                       5 blocked on review threads
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --branch)  BRANCH="${2:-}"; shift 2 ;;
    --title)   TITLE="${2:-}"; shift 2 ;;
    --body)    BODY="${2:-}"; shift 2 ;;
    --type)    TYPE="${2:-}"; shift 2 ;;
    --issue)   ISSUE="${2:-}"; shift 2 ;;
    --resolve) RESOLVE_MODE="${2:-}"; shift 2 ;;
    --draft)   DRAFT=1; shift ;;
    --no-wait) NO_WAIT=1; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    --_child) IS_CHILD=1; shift ;;
    -y|--yes)  ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown flag: $1 (try --help)" ;;
  esac
done

# --- preconditions ------------------------------------------------------------

command -v gh  >/dev/null || die "gh not found. brew install gh"
command -v git >/dev/null || die "git not found"
gh auth status >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

case "$RESOLVE_MODE" in
  coderabbit|manual|force) ;;
  *) die "--resolve must be coderabbit, manual or force (got: $RESOLVE_MODE)" ;;
esac

cd "$(git rev-parse --show-toplevel)" || die "not inside a git repository"

[[ -n "$TITLE" ]] || die "--title is required. It becomes the squash commit on main."

# The PR title IS the commit message here (squash-only), and release-please
# parses it. A non-conventional title silently produces no release.
if ! [[ "$TITLE" =~ ^(feat|fix|docs|ci|chore|refactor|test|perf|build|style|revert)(\([a-z0-9._/-]+\))?!?:\ .+ ]]; then
  die "title must be a Conventional Commit, e.g. 'fix: ...' or 'feat(api)!: ...'
   got: $TITLE
   Squash-merge means this title is the commit message release-please reads."
fi

if [[ -n "$ISSUE" && ! "$ISSUE" =~ ^[0-9]+$ ]]; then
  die "--issue must be a number (got: $ISSUE)"
fi

# --- detached child: skip setup, go straight to watching ----------------------
# The parent already branched, verified, pushed and opened the PR. The child
# only watches it, so everything above is skipped via SHIP_WATCH_PR.

if [[ "$IS_CHILD" -eq 1 ]]; then
  [[ -n "${SHIP_WATCH_PR:-}" ]] || die "--_child requires SHIP_WATCH_PR"
  PR_NUM="$SHIP_WATCH_PR"
  BRANCH="${SHIP_WATCH_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
  PR_URL="https://github.com/$REPO/pull/$PR_NUM"
  info "Watching PR #$PR_NUM (detached)"
  WATCH_ONLY=1
else
  WATCH_ONLY=0
fi

# --- work out the branch ------------------------------------------------------

slugify() {
  printf '%s' "$1" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/^[a-z]+(\([^)]*\))?!?:[[:space:]]*//' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' \
    | cut -c1-48 | sed -E 's/-+$//'
}

if [[ "$WATCH_ONLY" -eq 0 && -z "$BRANCH" ]]; then
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

if [[ "$WATCH_ONLY" -eq 0 ]]; then

CURRENT="$(git rev-parse --abbrev-ref HEAD)"

# Branching off a feature branch would sweep its commits into the PR.
if [[ "$CURRENT" != "main" ]] && ! git diff --quiet --exit-code; then
  if ! git merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    die "on '$CURRENT', which has commits not in main.
   Creating a branch here would include them in the PR.
   Switch to main first, or pass --branch to ship this branch as-is."
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
else
  MODE="new"
fi

# Changes sitting on main must move to a branch — main is push-protected.
if [[ "$MODE" == "new" ]]; then
  info "Changes detected on $CURRENT → moving to $BRANCH"
else
  info "Branch $BRANCH"
fi

# --- confirm ------------------------------------------------------------------

# Everything in the working tree goes into the commit, so show what that is.
# A stray untracked file would otherwise ride along into the PR unnoticed.
if [[ "$MODE" == "new" ]]; then
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
  echo "  resolve: $RESOLVE_MODE"
  [[ "$DRAFT" -eq 1 ]] && echo "  draft  : yes (no auto-merge)"
  echo
  printf 'Ship it? [y/N] '
  read -r reply </dev/tty || reply=""
  [[ "$reply" =~ ^[Yy] ]] || { echo "aborted"; exit 0; }
fi

# --- move changes onto a branch ----------------------------------------------

if [[ "$MODE" == "new" ]]; then
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    die "branch $BRANCH already exists. Pass a different --branch."
  fi
  # Uncommitted changes follow an ordinary checkout -b across, so `main` is
  # left untouched — no stash dance, nothing to lose if a later step fails.
  git checkout -b "$BRANCH" >/dev/null 2>&1 || die "could not create $BRANCH"
  ok "created $BRANCH"

  git add -A
  COMMIT_BODY=""
  [[ -n "$ISSUE" ]] && COMMIT_BODY="Closes #$ISSUE"

  if [[ -n "$COMMIT_BODY" ]]; then
    git commit -q -m "$TITLE" -m "$COMMIT_BODY" || die "commit failed"
  else
    git commit -q -m "$TITLE" || die "commit failed"
  fi
  ok "committed"
fi

# --- verify before pushing ----------------------------------------------------
# The pre-push hook runs this too, but failing here gives a clean error
# instead of a hook abort halfway through a push.

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

🤖 Opened by scripts/ship.sh"

# --- open the PR --------------------------------------------------------------

info "Opening pull request"
PR_ARGS=(--base main --head "$BRANCH" --title "$TITLE" --body "$PR_BODY")
[[ "$DRAFT" -eq 1 ]] && PR_ARGS+=(--draft)

PR_URL="$(gh pr create "${PR_ARGS[@]}")" || die "gh pr create failed"
PR_NUM="${PR_URL##*/}"
ok "PR #$PR_NUM — $PR_URL"

fi  # end WATCH_ONLY==0 setup phase

if [[ "$DRAFT" -eq 1 ]]; then
  echo
  info "Draft PR: CodeRabbit and auto-merge both skip drafts."
  info "Mark ready when you want it to land: gh pr ready $PR_NUM"
  exit 0
fi

if [[ "$NO_WAIT" -eq 1 ]]; then
  echo
  info "Not waiting (--no-wait). Auto-merge is armed; it lands on green."
  exit 0
fi

# --- detach -------------------------------------------------------------------
# The PR exists and auto-merge is armed; everything after this is watching.
# Re-exec ourselves in the background so the terminal (and an agent session)
# is free immediately. --foreground opts out.

LOG_DIR="$(git rev-parse --git-dir)/ship"
mkdir -p "$LOG_DIR"
SHIP_LOG="$LOG_DIR/pr-$PR_NUM.log"

if [[ "$FOREGROUND" -eq 0 && "$IS_CHILD" -eq 0 ]]; then
  # Hand the child the PR we already opened; it skips straight to watching.
  SHIP_WATCH_PR="$PR_NUM" SHIP_WATCH_BRANCH="$BRANCH" \
    nohup "$0" --_child --title "$TITLE" --resolve "$RESOLVE_MODE" --yes \
    >"$SHIP_LOG" 2>&1 &
  child=$!
  disown "$child" 2>/dev/null || true
  echo
  info "Watching in the background (pid $child)"
  info "  log:    $SHIP_LOG"
  info "  follow: tail -f $SHIP_LOG"
  info "  status: gh pr view $PR_NUM"
  echo
  ok "terminal is free — the PR merges on its own once green"
  exit 0
fi

# --- helpers for the watch loop ----------------------------------------------

pr_json() { gh pr view "$PR_NUM" --json "$1" --jq "$2" 2>/dev/null || echo ""; }

threads_json() {
  gh api graphql -f query="query{repository(owner:\"${REPO%%/*}\",name:\"${REPO##*/}\"){pullRequest(number:$PR_NUM){reviewThreads(first:100){nodes{id isResolved isOutdated path line comments(first:1){nodes{author{login}}}}}}}}" \
    --jq '.data.repository.pullRequest.reviewThreads.nodes' 2>/dev/null || echo "[]"
}

unresolved_count() {
  threads_json | python3 -c 'import sys,json
try: t=json.load(sys.stdin)
except Exception: print(-1); raise SystemExit
print(sum(1 for x in t if not x["isResolved"]))' 2>/dev/null || echo -1
}

print_unresolved() {
  threads_json | python3 -c 'import sys,json
try: t=json.load(sys.stdin)
except Exception: raise SystemExit
for x in t:
    if x.get("isResolved"): continue
    nodes = x.get("comments",{}).get("nodes") or [{}]
    author = (nodes[0].get("author") or {}).get("login","?")
    path = x.get("path","?")
    line = x.get("line") or "?"
    print("     {}:{}  ({})".format(path, line, author))' 2>/dev/null
}

# Zero unresolved threads is ambiguous: it means either "reviewed, nothing to
# flag" or "has not posted yet". Only the first is safe to act on, so look for
# positive evidence that a review happened — a review, a thread (resolved or
# not), or the CodeRabbit check reporting a conclusion.
review_arrived() {
  local seen
  seen="$(gh api graphql -f query="query{repository(owner:\"${REPO%%/*}\",name:\"${REPO##*/}\"){pullRequest(number:$PR_NUM){reviews(first:20){nodes{author{login}}} reviewThreads(first:1){nodes{id}}}}}" \
    --jq '[(.data.repository.pullRequest.reviews.nodes[]?|select(.author.login=="coderabbitai")),(.data.repository.pullRequest.reviewThreads.nodes[]?)]|length' 2>/dev/null || echo 0)"
  [[ "${seen:-0}" -gt 0 ]] && return 0

  # Fall back to the check run, which appears even on a no-findings review.
  local concl
  concl="$(gh pr view "$PR_NUM" --json statusCheckRollup \
    --jq '[.statusCheckRollup[]|select((.name//.context)=="CodeRabbit")|.conclusion//empty]|length' 2>/dev/null || echo 0)"
  [[ "${concl:-0}" -gt 0 ]]
}

# Everything that has to happen once the PR is merged, in one place.
#
# There are three exits that observe a merge — the check loop, the review loop
# and the auto-merge loop — because the merge can land while any of them is
# polling. Only the last one used to clean up, so a PR that merged during the
# review wait (the common case: auto-merge fires the moment CodeRabbit resolves
# its threads) left the branch checked out locally and alive on the remote.
# Every exit calls this instead.
#
# The remote delete is not redundant with the repository's
# `delete_branch_on_merge` setting: that setting does not reliably fire for a
# merge performed by auto-merge under the Actions token, which is how every PR
# here lands. Branches from previous runs were still on the remote with the
# setting enabled.
#
# Nothing here is fatal. The PR is merged either way, and failing the script
# over tidy-up would report a successful ship as an error.
cleanup_merged() {
  # A detached child holds no terminal, but it shares the working tree with
  # whatever the user is doing in it. Switching branches underneath an
  # interactive session is worse than leaving a merged branch behind, so the
  # child cleans up the remote only.
  if [[ "$IS_CHILD" -eq 0 ]]; then
    # Leave main checked out and current, ready for the next task.
    git checkout main >/dev/null 2>&1 && git pull --quiet >/dev/null 2>&1 || true
    # -D, not -d: the squash commit on main is a different object, so git does
    # not consider the branch merged and -d refuses it.
    git branch -D "$BRANCH" >/dev/null 2>&1 || true
  fi

  git push origin --delete "$BRANCH" >/dev/null 2>&1 \
    && ok "deleted branch $BRANCH" \
    || true
  git fetch origin --prune >/dev/null 2>&1 || true
}

resolve_all_threads() {
  local ids
  ids="$(threads_json | python3 -c 'import sys,json
try: t=json.load(sys.stdin)
except Exception: raise SystemExit
print("\n".join(x["id"] for x in t if not x["isResolved"]))' 2>/dev/null)"
  [[ -z "$ids" ]] && return 0
  local id
  while read -r id; do
    [[ -z "$id" ]] && continue
    gh api graphql -f query="mutation{resolveReviewThread(input:{threadId:\"$id\"}){thread{isResolved}}}" >/dev/null 2>&1 || true
  done <<<"$ids"
}

# --- wait for required checks -------------------------------------------------

info "Waiting for required checks (timeout ${CHECK_TIMEOUT}s)"
deadline=$(( $(date +%s) + CHECK_TIMEOUT ))
while :; do
  state="$(pr_json state '.state')"
  [[ "$state" == "MERGED" ]] && { ok "merged while waiting"; cleanup_merged; echo; info "$PR_URL"; exit 0; }
  [[ "$state" == "CLOSED" ]] && die "PR was closed"

  rollup="$(gh pr view "$PR_NUM" --json statusCheckRollup --jq '.statusCheckRollup' 2>/dev/null || echo "[]")"
  # Required check names are passed as argv, not interpolated into the source.
  read -r pending failed <<<"$(printf '%s' "$rollup" | python3 -c '
import sys,json
req=set(sys.argv[1:])
try: r=json.load(sys.stdin) or []
except Exception: print("1 0"); raise SystemExit
p=f=0
for c in r:
    n=c.get("name") or c.get("context")
    if n not in req: continue
    if c.get("status")!="COMPLETED": p+=1
    elif c.get("conclusion") not in ("SUCCESS","NEUTRAL","SKIPPED"): f+=1
print(f"{p} {f}")' "${REQUIRED_CHECKS[@]}" 2>/dev/null || echo "1 0")"

  if [[ "${failed:-0}" -gt 0 ]]; then
    echo
    warn "required checks failed"
    gh pr checks "$PR_NUM" 2>/dev/null | grep -vE '^\s*$' | head -20 >&2 || true
    echo
    warn "PR left open for inspection: $PR_URL"
    exit 3
  fi
  [[ "${pending:-1}" -eq 0 ]] && { ok "required checks green"; break; }

  (( $(date +%s) > deadline )) && { warn "timed out waiting for checks"; warn "$PR_URL"; exit 4; }
  sleep "$POLL"
done

# --- settle review threads ----------------------------------------------------
# required_conversation_resolution is ON for main, so ANY unresolved thread
# blocks the merge even though the CodeRabbit check itself is not required.

info "Waiting for review threads to settle"
review_deadline=$(( $(date +%s) + REVIEW_TIMEOUT ))
asked_resolve=0

while :; do
  state="$(pr_json state '.state')"
  # The usual finish: auto-merge fires the moment CodeRabbit resolves its
  # threads, so the merge lands here rather than in the auto-merge loop below.
  [[ "$state" == "MERGED" ]] && { ok "merged"; cleanup_merged; echo; info "$PR_URL"; exit 0; }

  n="$(unresolved_count)"

  if [[ "$n" -eq 0 ]]; then
    # Nothing unresolved — but make sure that is because the review happened,
    # not because it has not started. Otherwise threads land after we move on.
    if review_arrived; then
      ok "review complete, no unresolved threads"
      break
    fi
    if (( $(date +%s) > review_deadline )); then
      echo
      warn "no CodeRabbit review after ${REVIEW_TIMEOUT}s"
      warn "Proceeding anyway — auto-merge still gates on the required checks."
      break
    fi
    sleep "$POLL"
    continue
  fi

  if [[ "$n" -gt 0 ]]; then
    case "$RESOLVE_MODE" in
      force)
        warn "$n unresolved thread(s) — resolving unread (--resolve force)"
        resolve_all_threads
        sleep 5
        continue
        ;;
      manual)
        echo
        warn "$n unresolved review thread(s) block the merge:"
        print_unresolved >&2
        echo
        warn "Address them, then: gh pr comment $PR_NUM --body '@coderabbitai resolve'"
        warn "$PR_URL"
        exit 5
        ;;
      coderabbit)
        if [[ "$asked_resolve" -eq 0 ]]; then
          info "$n unresolved thread(s) — asking CodeRabbit to resolve its own"
          gh pr comment "$PR_NUM" --body "@coderabbitai resolve" >/dev/null 2>&1 \
            || warn "could not post the resolve comment"
          asked_resolve=1
          sleep 45
          continue
        fi
        ;;
    esac
  fi

  if (( $(date +%s) > review_deadline )); then
    echo
    if [[ "$n" -gt 0 ]]; then
      warn "$n thread(s) still unresolved after ${REVIEW_TIMEOUT}s"
      print_unresolved >&2
      echo
      warn "CodeRabbit did not resolve them. Options:"
      warn "  address the feedback, then re-run with --resolve force, or"
      warn "  resolve by hand in the UI"
    else
      warn "timed out waiting for review"
    fi
    warn "$PR_URL"
    exit 5
  fi
  sleep "$POLL"
done

# --- wait for auto-merge ------------------------------------------------------

info "Waiting for auto-merge"
merge_deadline=$(( $(date +%s) + MERGE_TIMEOUT ))
nudged=0
while :; do
  state="$(pr_json state '.state')"
  if [[ "$state" == "MERGED" ]]; then
    echo
    ok "merged to main"
    info "$PR_URL"
    cleanup_merged
    exit 0
  fi
  [[ "$state" == "CLOSED" ]] && die "PR was closed without merging"

  ms="$(pr_json mergeStateStatus '.mergeStateStatus')"

  # auto-merge should already be armed by the workflow; nudge once if not.
  if [[ "$nudged" -eq 0 ]]; then
    armed="$(pr_json autoMergeRequest '.autoMergeRequest != null')"
    if [[ "$armed" == "false" ]]; then
      gh pr merge "$PR_NUM" --squash --auto >/dev/null 2>&1 || true
      nudged=1
    fi
  fi

  if [[ "$ms" == "DIRTY" ]]; then
    warn "merge conflict with main — rebase required"
    warn "$PR_URL"
    exit 5
  fi
  if [[ "$ms" == "BEHIND" ]]; then
    info "branch behind main; updating"
    gh pr update-branch "$PR_NUM" >/dev/null 2>&1 || true
  fi

  if (( $(date +%s) > merge_deadline )); then
    echo
    warn "still not merged after ${MERGE_TIMEOUT}s (mergeStateStatus=$ms)"
    if [[ "$ms" == "BLOCKED" ]]; then
      n="$(unresolved_count)"
      [[ "$n" -gt 0 ]] && { warn "$n thread(s) reappeared:"; print_unresolved >&2; }
    fi
    warn "$PR_URL"
    exit 4
  fi
  sleep "$POLL"
done
