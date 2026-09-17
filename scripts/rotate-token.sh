#!/usr/bin/env bash
#
# rotate-token.sh — replace AUTO_MERGE_TOKEN, verifying before and after.
#
# AUTO_MERGE_TOKEN is what auto-merge.yml squash-merges with. It exists because
# GitHub raises no events for pushes made with the default GITHUB_TOKEN, so a
# merge performed with that token never triggers ci.yml or cd.yml — see the note
# on the arming step in .github/workflows/auto-merge.yml. A dead token here
# means main stops deploying, quietly.
#
#   ./scripts/rotate-token.sh                    # prompts, nothing hits history
#   ./scripts/rotate-token.sh --check            # is the stored one still good?
#   ./scripts/rotate-token.sh <token>            # inline; see the warning below
#   op read "op://Private/gh-auto-merge/token" | ./scripts/rotate-token.sh -
#
# PASSING A TOKEN AS AN ARGUMENT LEAKS IT. It lands in ~/.zsh_history, in `ps`
# output while this runs, and in the scrollback of whatever opened the terminal.
# The script accepts it because a caller that already has the value in a
# variable should not be forced through a prompt, but it warns every time and
# tells you to rotate again if the shell was interactive. Prefer no argument
# (prompts, silently) or `-` (reads stdin, for a password manager).
#
# Minting the replacement is a browser step — GitHub has no API for issuing a
# PAT. This script covers everything either side of it: checking what you have,
# validating what you minted, storing it, and confirming the result.
#
# See scripts/README.md for the token's required permissions.

set -euo pipefail

REPO="lunox-work/sandbox-factory"
SECRET="AUTO_MERGE_TOKEN"
NEW_TOKEN_URL="https://github.com/settings/personal-access-tokens/new"

CHECK_ONLY=0 ASSUME_YES=0 TOKEN=""

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }

usage() {
  sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Arguments:
  <token>             The new token. Leaks into shell history — prefer stdin.
  -                   Read the token from stdin (for a password manager).
  (none)              Prompt for it with echo off.

Flags:
  --check             Validate the stored token and exit. Changes nothing.
  --yes, -y           Skip the confirmation prompt.
  -h, --help          This message.

Exit codes:
  0 rotated (or --check passed)      2 the new token is unusable
  1 usage/precondition error         3 --check: stored token is bad
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   CHECK_ONLY=1; shift ;;
    -y|--yes)  ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -)         TOKEN="$(cat)"; shift ;;
    -*)        die "unknown flag: $1 (try --help)" ;;
    *)
      [[ -z "$TOKEN" ]] || die "more than one token given"
      TOKEN="$1"
      # Only a real terminal writes history; a pipeline or CI run does not.
      if [[ -t 0 ]]; then
        warn "the token was passed as an argument, so it is now in your shell history."
        warn "treat it as compromised: finish this rotation, then rotate again from a prompt."
      fi
      shift ;;
  esac
done

command -v gh >/dev/null || die "gh not found. brew install gh"
gh auth status >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

# Whether a token can do the two things auto-merge.yml needs: read the pull
# request it is about to merge, and write to the repository. Checked as a pair
# because a token with one and not the other fails at the merge rather than at
# arming, which is the failure this script exists to prevent.
#
# Prints the identity on success so a rotation onto the wrong account is
# visible now rather than the next time main fails to deploy.
validate() {
  local token="$1" login perms
  if ! login="$(GH_TOKEN="$token" gh api user --jq .login 2>/dev/null)"; then
    echo "cannot authenticate — expired, revoked, or not a valid token"
    return 1
  fi
  if ! perms="$(GH_TOKEN="$token" gh api "repos/$REPO" --jq '.permissions.push' 2>/dev/null)"; then
    echo "authenticates as $login but cannot see $REPO — wrong resource owner, or awaiting org approval"
    return 1
  fi
  if [[ "$perms" != "true" ]]; then
    echo "authenticates as $login but lacks write access — needs Contents: read and write"
    return 1
  fi
  # The same call the workflow makes before trusting the token. A token scoped
  # without `pull_requests` passes everything above and fails only here.
  if ! GH_TOKEN="$token" gh pr list --repo "$REPO" --limit 1 >/dev/null 2>&1; then
    echo "authenticates as $login but cannot read pull requests — needs Pull requests: read and write"
    return 1
  fi
  echo "$login"
  return 0
}

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  info "Checking the stored $SECRET"
  # GitHub never discloses a secret's value, so the stored token cannot be read
  # back and tested directly. What is observable is whether the last merge used
  # it: the fallback branch in auto-merge.yml logs a warning when it did not.
  if ! gh secret list --repo "$REPO" --json name --jq '.[].name' 2>/dev/null | grep -qx "$SECRET"; then
    warn "$SECRET is not set. Merges fall back to the default token and main will not deploy."
    exit 3
  fi
  ok "$SECRET exists (set $(gh secret list --repo "$REPO" --json name,updatedAt --jq ".[]|select(.name==\"$SECRET\")|.updatedAt"))"

  info "Looking for the fallback warning in recent auto-merge runs"
  run_id="$(gh run list --repo "$REPO" --workflow=auto-merge.yml -L 1 --json databaseId --jq '.[0].databaseId' 2>/dev/null || true)"
  if [[ -z "$run_id" ]]; then
    warn "no auto-merge runs yet — nothing to infer from"
    exit 0
  fi
  if gh run view "$run_id" --repo "$REPO" --log 2>/dev/null | grep -q "AUTO_MERGE_TOKEN is set but cannot read"; then
    warn "the last merge found $SECRET unusable and fell back. Rotate it."
    exit 3
  fi
  if gh run view "$run_id" --repo "$REPO" --log 2>/dev/null | grep -q "does not trigger CI or CD"; then
    warn "the last merge used the default token. $SECRET was empty or unusable at the time."
    exit 3
  fi
  ok "the last auto-merge run shows no fallback warning"
  exit 0
fi

if [[ -z "$TOKEN" ]]; then
  cat <<EOF

Mint the replacement first, in a browser:

  $NEW_TOKEN_URL

  Resource owner        lunox-work        (the org, not your personal account)
  Repository access     Only select repositories -> ${REPO#*/}
  Permissions           Contents            Read and write
                        Pull requests       Read and write

Revoke the old one on that same settings page once this finishes.

EOF
  # -s so the paste never appears on screen or in history.
  read -r -s -p "Paste the new token (input hidden): " TOKEN
  echo
fi

[[ -n "$TOKEN" ]] || die "no token given"

# Trailing newlines survive a pipe from `op read` or a heredoc and would be
# stored as part of the secret, producing a token that fails every call for a
# reason nothing reports.
TOKEN="${TOKEN%%[[:space:]]}"
TOKEN="$(printf '%s' "$TOKEN" | tr -d '\r\n')"

info "Validating the new token before storing it"
if ! identity="$(validate "$TOKEN")"; then
  die "the new token is unusable: $identity
   Nothing was changed; $SECRET still holds its previous value."
fi
ok "authenticates as $identity, with write and pull-request access to $REPO"

if [[ "$identity" != *"[bot]"* ]]; then
  warn "this is a personal token, so every automatic deploy will be attributed to $identity"
  warn "and will stop working if that account loses access. A GitHub App installation"
  warn "token avoids both; see scripts/README.md."
fi

if [[ "$ASSUME_YES" -ne 1 ]]; then
  printf '\nStore this as %s on %s? [y/N] ' "$SECRET" "$REPO"
  read -r reply
  [[ "$reply" =~ ^[Yy]$ ]] || die "aborted; nothing was changed"
fi

info "Storing $SECRET"
printf '%s' "$TOKEN" | gh secret set "$SECRET" --repo "$REPO"
ok "stored"

# Read back what the API reports rather than trusting the write, so a silent
# failure surfaces here instead of at the next merge.
stored_at="$(gh secret list --repo "$REPO" --json name,updatedAt --jq ".[]|select(.name==\"$SECRET\")|.updatedAt" 2>/dev/null || true)"
[[ -n "$stored_at" ]] || die "the secret does not read back — the write did not take effect"
ok "$SECRET updated at $stored_at"

cat <<EOF

Done. Two things remain, and neither is automatic:

  1. Revoke the old token at
     https://github.com/settings/personal-access-tokens
     Until you do, it still merges and deploys.

  2. Confirm the rotation on the next merge:
     ./scripts/rotate-token.sh --check

The new token takes effect on the next PR merged. Nothing needs redeploying.
EOF
