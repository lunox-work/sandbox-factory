#!/usr/bin/env bash
#
# rotate-token.sh — rotate the credentials this project runs on.
#
# Two sets, kept separate because they live in different places and fail in
# different ways.
#
#   AUTO_MERGE_TOKEN   a GitHub Actions secret. auto-merge.yml squash-merges
#                      with it, because GitHub raises no events for pushes made
#                      with the default GITHUB_TOKEN — so a merge performed with
#                      that token never triggers ci.yml or cd.yml. A dead token
#                      here stops main deploying, quietly.
#
#   .env.production    the application secrets, which reach the API
#                      through AWS Secrets Manager. A dead one here crash-loops
#                      the task on its next boot, loudly.
#
#   ./scripts/rotate-token.sh                    # the GitHub token; prompts
#   ./scripts/rotate-token.sh --check            # is the stored one still good?
#   ./scripts/rotate-token.sh --secrets          # the app secrets
#   ./scripts/rotate-token.sh --secrets --only DATABASE_URL
#   ./scripts/rotate-token.sh <token>            # inline; see the warning below
#   op read "op://Private/gh-auto-merge/token" | ./scripts/rotate-token.sh -
#
# --secrets asks for each key in turn and SKIPS ANY YOU LEAVE BLANK, so rotating
# one credential does not mean re-pasting all the others. It rewrites
# .env.production in place, then offers to push the changed keys to AWS and to
# restart the API so they take effect. Both are prompts, not automatic.
#
# PASSING A TOKEN AS AN ARGUMENT LEAKS IT. It lands in ~/.zsh_history, in `ps`
# output while this runs, and in the scrollback of whatever opened the terminal.
# The script accepts it because a caller that already has the value in a
# variable should not be forced through a prompt, but it warns every time and
# tells you to rotate again if the shell was interactive. Prefer no argument
# (prompts, silently) or `-` (reads stdin, for a password manager).
#
# Minting a replacement is always a browser step — no provider here has an API
# for issuing credentials. This script covers everything either side of it.
#
# See scripts/README.md for each credential's console location.

set -euo pipefail

REPO="lunox-work/sandbox-factory"
SECRET="AUTO_MERGE_TOKEN"
NEW_TOKEN_URL="https://github.com/settings/personal-access-tokens/new"

PROJECT="${PROJECT:-sandbox-factory}"
REGION="${AWS_REGION:-us-east-1}"

CHECK_ONLY=0 ASSUME_YES=0 TOKEN="" SECRETS_MODE=0 ONLY_KEY=""

die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
info() { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarn:\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }

# The app secrets, in .env.production order. Keep in step with
# `local.app_secrets` in infra/secrets.tf and `KEYS` in
# infra/scripts/secrets-push.sh.
SECRET_KEYS=(
  DATABASE_URL
  BETTER_AUTH_SECRET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  ATLASSIAN_CLIENT_ID
  ATLASSIAN_CLIENT_SECRET
  JIRA_CLIENT_ID
  JIRA_CLIENT_SECRET
  TOKEN_ENCRYPTION_KEY
  ANTHROPIC_API_KEY
  SIZING_MODEL
)

secret_hint() {
  case "$1" in
    DATABASE_URL)
      echo "Neon console -> Project -> Connection string. Reset the password to rotate.
       Must end ?sslmode=require, and prefer the pooled host (contains -pooler)." ;;
    BETTER_AUTH_SECRET)
      echo "Generate locally: openssl rand -base64 32
       Rotating this invalidates every existing session — everyone signs in again." ;;
    GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET)
      echo "console.cloud.google.com -> APIs & Services -> Credentials -> OAuth client.
       The secret can be rotated without touching the ID." ;;
    GITHUB_CLIENT_ID|GITHUB_CLIENT_SECRET)
      echo "github.com/settings/developers -> OAuth Apps -> the app -> Generate a new
       client secret. The ID never changes." ;;
    ATLASSIAN_CLIENT_ID|ATLASSIAN_CLIENT_SECRET)
      echo "developer.atlassian.com -> Console -> the SIGN-IN app -> Settings.
       Identity only (read:me); the Jira scopes belong to the other app." ;;
    JIRA_CLIENT_ID|JIRA_CLIENT_SECRET)
      echo "developer.atlassian.com -> Console -> the JIRA CONNECTION app -> Settings.
       A second app on purpose: an Atlassian grant is per app and a new grant
       overwrites the old one's scopes, so sharing one with sign-in would make
       the two flows break each other." ;;
    TOKEN_ENCRYPTION_KEY)
      echo "Generate locally: openssl rand -base64 32
       NOT a drop-in rotation: it decrypts the tokens in jira_connection, so
       replacing it alone leaves every stored Jira token unreadable and every
       connection has to be made again. Re-encrypt those rows first — key_id
       records which key wrote each one so both can be readable while you do." ;;
    ANTHROPIC_API_KEY)
      echo "console.anthropic.com -> Settings -> API keys.
       Optional; sizing stays unavailable until SIZING_MODEL is also set." ;;
    SIZING_MODEL)
      echo "An explicit model identifier available to the Anthropic account.
       Optional; verify it in the provider account before setting it." ;;
  esac
}

usage() {
  sed -n '2,39p' "$0" | sed 's/^# \{0,1\}//'
  cat <<'EOF'

Arguments:
  <token>             The new token. Leaks into shell history — prefer stdin.
  -                   Read the token from stdin (for a password manager).
  (none)              Prompt for it with echo off.

Flags:
  --secrets           Rotate .env.production values instead of the GitHub
                      token. Asks for each key; blank input keeps the current
                      value.
  --only <KEY>        With --secrets, ask about this one key only.
  --check             Validate the stored token and exit. Changes nothing.
  --yes, -y           Skip confirmation prompts.
  -h, --help          This message.

Exit codes:
  0 rotated, or --check passed       2 the new token is unusable
  1 usage/precondition error         3 --check: stored token is bad
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   CHECK_ONLY=1; shift ;;
    --secrets) SECRETS_MODE=1; shift ;;
    --only)    ONLY_KEY="${2:-}"; shift 2 ;;
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

if [[ -n "$ONLY_KEY" && "$SECRETS_MODE" -ne 1 ]]; then
  die "--only applies to --secrets"
fi

# The secrets branch below exits before the CHECK_ONLY branch runs, so the
# combination would rewrite .env.production while claiming to be read-only.
if [[ "$CHECK_ONLY" -eq 1 && "$SECRETS_MODE" -eq 1 ]]; then
  die "--check cannot be combined with --secrets: --check changes nothing, and
   rotating secrets is a write. Run them separately."
fi

# ---- .env.production ---------------------------------------------------------

if [[ "$SECRETS_MODE" -eq 1 ]]; then
  ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
  ENV_FILE="$ROOT/.env.production"
  PUSH_SCRIPT="$ROOT/infra/scripts/secrets-push.sh"

  [[ -f "$ENV_FILE" ]] || die "no .env.production at $ENV_FILE
   Create one first: make secrets-template"

  if [[ -n "$ONLY_KEY" ]]; then
    printf '%s\n' "${SECRET_KEYS[@]}" | grep -qx -- "$ONLY_KEY" \
      || die "--only: $ONLY_KEY is not one of the rotatable keys (try --help)"
  fi

  # Read one key without sourcing the file, which would execute a stray
  # backtick in a secret. Mirrors read_value in infra/scripts/secrets-push.sh,
  # including last-occurrence-wins.
  read_value() {
    local key="$1" line value
    line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
    [[ -z "$line" ]] && return 1
    value="${line#*=}"
    if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
      value="${BASH_REMATCH[1]}"
    fi
    printf '%s' "$value"
  }

  # Enough of a value to recognise it, never enough to reconstruct it.
  redact() {
    local v="$1" n=${#1}
    if   (( n <= 8 ));  then printf '%s' "********"
    elif (( n <= 24 )); then printf '%.2s…%s' "$v" "$(printf '%*s' 6 '' | tr ' ' '*')"
    else printf '%.4s…%.4s (%d chars)' "$v" "${v: -4}" "$n"
    fi
  }

  cat <<EOF

Rotating application secrets in .env.production.

Each key is asked in turn. Press Enter to keep the current value — only the
ones you paste are changed. Input is hidden.

These reach the API through AWS Secrets Manager, not from this file directly,
so nothing takes effect until the push step at the end.

EOF

  declare -a changed_keys=() changed_vals=()
  for key in "${SECRET_KEYS[@]}"; do
    [[ -n "$ONLY_KEY" && "$key" != "$ONLY_KEY" ]] && continue

    current="$(read_value "$key" || true)"
    printf '\033[1m%s\033[0m\n' "$key"
    if [[ -z "$current" || "$current" == "REPLACE_ME" || "$current" == replace-me* ]]; then
      printf '  current: \033[33mnot set\033[0m\n'
    else
      printf '  current: %s\n' "$(redact "$current")"
    fi
    printf '  where:   %s\n' "$(secret_hint "$key")"

    read -r -s -p "  new value (Enter to skip): " newval
    echo
    # Pasted credentials often carry stray whitespace, which would be stored
    # and then fail every call with no explanation.
    newval="$(printf '%s' "$newval" | tr -d '\r\n' | sed -E 's/^[[:space:]]+|[[:space:]]+$//g')"

    if [[ -z "$newval" ]]; then
      printf '  \033[2mkept\033[0m\n\n'
      continue
    fi
    if [[ "$newval" == "$current" ]]; then
      warn "identical to the current value — treating as unchanged"
      printf '\n'
      continue
    fi
    changed_keys+=("$key")
    changed_vals+=("$newval")
    printf '  \033[32mwill change\033[0m\n\n'
  done

  if [[ ${#changed_keys[@]} -eq 0 ]]; then
    info "nothing entered — no changes made"
    exit 0
  fi

  info "${#changed_keys[@]} key(s) to rotate: ${changed_keys[*]}"
  if [[ "$ASSUME_YES" -ne 1 ]]; then
    printf 'Rewrite .env.production with these? [y/N] '
    read -r reply
    [[ "$reply" =~ ^[Yy]$ ]] || die "aborted; nothing was changed"
  fi

  # Replace only the matched lines, so the file keeps its comments and stays
  # diffable against .env.example. Write to a temp file and move it into place
  # so an interrupted run cannot leave half-written credentials. The backup
  # keeps the previous values recoverable.
  BACKUP="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
  cp -p "$ENV_FILE" "$BACKUP"
  chmod 600 "$BACKUP"

  TMP="$(mktemp "${TMPDIR:-/tmp}/rotate.XXXXXX")"
  chmod 600 "$TMP"
  cp -p "$ENV_FILE" "$TMP"

  for i in "${!changed_keys[@]}"; do
    key="${changed_keys[$i]}"
    val="${changed_vals[$i]}"
    # awk, not sed: sed would interpret `&`, `/` or a backslash in the value.
    # awk takes it as a plain string through the environment.
    KEY="$key" VAL="$val" awk '
      BEGIN { key = ENVIRON["KEY"]; val = ENVIRON["VAL"]; done = 0 }
      $0 ~ "^" key "=" { print key "=" val; done = 1; next }
      { print }
      END { if (!done) print key "=" val }
    ' "$TMP" > "$TMP.new" && mv "$TMP.new" "$TMP"
  done

  mv "$TMP" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "rewrote .env.production (previous copy: ${BACKUP##*/})"

  # Validate the way the API does at boot, before anything reaches production.
  if [[ -x "$ROOT/infra/scripts/secrets-check.sh" ]]; then
    info "Validating the file"
    if ! "$ROOT/infra/scripts/secrets-check.sh" >/dev/null 2>&1; then
      warn "secrets-check reports a problem — running it again to show you:"
      "$ROOT/infra/scripts/secrets-check.sh" || true
      warn "the previous values are in ${BACKUP##*/}"
      die "not pushing a file that fails validation"
    fi
    ok "valid"
  fi

  # ---- push --------------------------------------------------------------

  if [[ ! -x "$PUSH_SCRIPT" ]]; then
    warn "no secrets-push.sh found; push manually with: make secrets-push"
    exit 0
  fi

  echo
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    reply=y
  else
    printf 'Push to AWS Secrets Manager now? [y/N] '
    read -r reply
  fi

  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    cat <<EOF

Stopped before pushing. The new values are in .env.production and nowhere else.

  make secrets-push     when you are ready

EOF
    exit 0
  fi

  command -v aws >/dev/null || die "aws CLI not found, and the push needs it"
  aws sts get-caller-identity >/dev/null 2>&1 || die "aws CLI is not authenticated for $REGION"

  # Push only what changed. Other values in .env.production may have drifted
  # from Secrets Manager, and pushing them would overwrite live credentials.
  declare -a push_args=()
  for key in "${changed_keys[@]}"; do
    push_args+=(--only "$key")
  done

  info "Pushing to AWS Secrets Manager: ${changed_keys[*]}"
  "$PUSH_SCRIPT" "${push_args[@]}" \
    || die "push failed; .env.production still holds the new values"
  ok "pushed"

  # ---- restart -------------------------------------------------------------

  # ECS reads Secrets Manager when a task starts, so a running task keeps its
  # old values until it is replaced.
  echo
  if [[ "$ASSUME_YES" -eq 1 ]]; then
    reply=y
  else
    printf 'Restart the API so the new values take effect? [y/N] '
    read -r reply
  fi

  if [[ ! "$reply" =~ ^[Yy]$ ]]; then
    cat <<EOF

Pushed, but the running task still holds the old values. It picks them up on
its next start — the next deploy, or:

  aws ecs update-service --cluster $PROJECT --service $PROJECT-api \\
    --force-new-deployment --region $REGION

EOF
    exit 0
  fi

  info "Forcing a new deployment"
  aws ecs update-service \
    --cluster "$PROJECT" \
    --service "$PROJECT-api" \
    --force-new-deployment \
    --region "$REGION" \
    --query 'service.deployments[0].{status:rolloutState,desired:desiredCount}' \
    --output table \
    || die "could not restart the service; the values are pushed, so a deploy will apply them"

  cat <<EOF

$(ok "rotation complete")

The new task takes a minute or two to become healthy. If a rotated value is
wrong the task crash-loops rather than serving errors — watch it with:

  aws logs tail /ecs/$PROJECT-api --follow --region $REGION

Rolling back means putting the old value from ${BACKUP##*/} back and
re-running this. Then delete that backup: it holds live credentials.
EOF
  exit 0
fi

# ---- AUTO_MERGE_TOKEN --------------------------------------------------------

command -v gh >/dev/null || die "gh not found. brew install gh"
gh auth status >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

# Whether a token can do both things auto-merge.yml needs: read the pull
# request and write to the repository. A token with only one fails at the
# merge rather than at arming. Prints the login on success, so a rotation onto
# the wrong account is visible now; prints the reason on failure.
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
  # The call the workflow makes before trusting the token. A token without
  # `pull_requests` passes everything above and fails only here.
  if ! GH_TOKEN="$token" gh pr list --repo "$REPO" --limit 1 >/dev/null 2>&1; then
    echo "authenticates as $login but cannot read pull requests — needs Pull requests: read and write"
    return 1
  fi
  echo "$login"
  return 0
}

if [[ "$CHECK_ONLY" -eq 1 ]]; then
  info "Checking the stored $SECRET"
  # GitHub never discloses a secret's value, so the stored token cannot be
  # tested directly. Instead, look for the warning auto-merge.yml's fallback
  # branch logs when the last merge could not use it.
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

Mint the replacement first, in a browser. GitHub has no API for issuing a
token, so this part cannot be scripted.

  $NEW_TOKEN_URL

1. Token name          anything; "auto-merge" is the obvious choice.

2. Resource owner      lunox-work

   A dropdown, and it defaults to your personal account. Pick the
   organisation. A token owned by the wrong account authenticates fine and
   then cannot see this repository at all.

3. Repository access   "Only select repositories" -> ${REPO#*/}

   Not "All repositories". This token merges to main; it has no business
   anywhere else.

4. Permissions         Repository permissions -> set two, leave the rest

   Contents            Access: Read and write
   Pull requests       Access: Read and write

   Each is a dropdown next to its name, defaulting to "No access". Both must
   read "Read and write" before the token will work:

     Contents       lets auto-merge.yml push the squash commit to main. This
                    is the permission that makes CI and CD run at all.
     Pull requests  lets it read and merge the PR. A token with Contents but
                    not this one passes a naive check and then fails at the
                    merge, which is why this script tests both.

   "Metadata: Read-only" switches itself on and cannot be removed. Expected.

5. Expiration          90 days is the sensible maximum.

   When it lapses, merges keep working and silently stop deploying. Put the
   expiry in a calendar now; \`$(basename "$0") --check\` is how you confirm
   later.

6. Generate token, then copy it. GitHub shows it once.

If the organisation requires approval for fine-grained tokens, it stays inert
until an owner approves it under the org's settings. This script reports that
case as "cannot see the repo".

Revoke the old one on that same settings page once this finishes.

EOF
  # -s so the paste never appears on screen or in history.
  read -r -s -p "Paste the new token (input hidden): " TOKEN
  echo
fi

[[ -n "$TOKEN" ]] || die "no token given"

# A trailing newline survives a pipe from `op read` and would be stored as part
# of the secret.
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

# Read the secret's timestamp back, so a silent write failure surfaces here
# instead of at the next merge.
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
