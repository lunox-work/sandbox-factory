#!/usr/bin/env bash
#
# Validate .env.production before pushing it.
#
#   ./infra/scripts/secrets-check.sh
#
# Checks what apps/api/src/env.ts checks at boot, so a mistake is caught here
# rather than as a crash-looping task. Prints lengths and shapes, never values.

set -euo pipefail

ENV_FILE="${1:-$(git rev-parse --show-toplevel)/.env.production}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No env file at: $ENV_FILE" >&2
  echo "Run: make secrets-template" >&2
  exit 1
fi

read_value() {
  local line
  line="$(grep -E "^$1=" "$ENV_FILE" | tail -1 || true)"
  [[ -z "$line" ]] && return 1
  local value="${line#*=}"
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

fail=0
note() { printf '  %-26s %s\n' "$1" "$2"; }

echo "Checking $ENV_FILE"
echo

# --- DATABASE_URL: the one with a shape worth verifying --------------------
if db="$(read_value DATABASE_URL)" && [[ -n "$db" ]]; then
  if [[ "$db" != postgres://* && "$db" != postgresql://* ]]; then
    note DATABASE_URL "BAD — must start with postgres:// or postgresql://"; fail=1
  elif [[ "$db" != *"sslmode=require"* ]]; then
    # Neon refuses an unencrypted connection, and the error never mentions TLS.
    note DATABASE_URL "BAD — missing ?sslmode=require (Neon will refuse it)"; fail=1
  elif [[ "$db" == *localhost* || "$db" == *127.0.0.1* ]]; then
    note DATABASE_URL "BAD — points at localhost, not Neon"; fail=1
  else
    host="$(printf '%s' "$db" | sed -n 's|.*@\([^/?]*\).*|\1|p')"
    note DATABASE_URL "ok — host ${host}"
    [[ "$db" == *-pooler.* ]] || note "" "note: not the pooled endpoint; pooled is preferred"
  fi
else
  note DATABASE_URL "EMPTY — paste your Neon connection string"; fail=1
fi

# --- BETTER_AUTH_SECRET: length is enforced at boot ------------------------
if s="$(read_value BETTER_AUTH_SECRET)" && [[ -n "$s" ]]; then
  if (( ${#s} < 32 )); then
    note BETTER_AUTH_SECRET "BAD — ${#s} chars, needs 32+"; fail=1
  else
    note BETTER_AUTH_SECRET "ok (${#s} chars)"
  fi
else
  note BETTER_AUTH_SECRET "EMPTY — openssl rand -base64 32"; fail=1
fi

# --- TOKEN_ENCRYPTION_KEY: must decode to exactly 32 bytes -----------------
# Checked here and not only at boot: a wrong-length key fails the API's own
# validation on start, which in production means a deploy that will not come
# up rather than a message at the moment the value is set.
if k="$(read_value TOKEN_ENCRYPTION_KEY)" && [[ -n "$k" ]]; then
  bytes="$(printf %s "$k" | base64 -d 2>/dev/null | wc -c | tr -d ' ')"
  if [[ "$bytes" != 32 ]]; then
    note TOKEN_ENCRYPTION_KEY "BAD — decodes to ${bytes:-0} bytes, needs 32"; fail=1
  else
    note TOKEN_ENCRYPTION_KEY "ok (32 bytes)"
  fi
else
  note TOKEN_ENCRYPTION_KEY "EMPTY — openssl rand -base64 32"; fail=1
fi

# --- OAuth: presence only; only the provider can say if they are right -----
for k in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET \
         GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET \
         ATLASSIAN_CLIENT_ID ATLASSIAN_CLIENT_SECRET; do
  if v="$(read_value "$k")" && [[ -n "$v" && "$v" != REPLACE_ME ]]; then
    note "$k" "ok (${#v} chars)"
  else
    note "$k" "EMPTY"; fail=1
  fi
done

# --- The Jira app: optional, and both halves or neither --------------------
#
# `JIRA_CLIENT_ID`/`_SECRET` are `.optional()` in apps/api/src/env.ts: with
# them unset the API boots and `jiraOAuthConfig` returns undefined, which
# leaves the Jira connect routes unmounted. Failing the push over them would
# say the API cannot start, which is untrue.
#
# One without the other is still a mistake — `jiraOAuthConfig` needs both, so a
# half-filled pair reads as "Jira configured" to a human and as "not
# configured" to the API.
jira_id="$(read_value JIRA_CLIENT_ID || true)"
jira_secret="$(read_value JIRA_CLIENT_SECRET || true)"
[[ "$jira_id" == REPLACE_ME ]] && jira_id=""
[[ "$jira_secret" == REPLACE_ME ]] && jira_secret=""

if [[ -n "$jira_id" && -n "$jira_secret" ]]; then
  note JIRA_CLIENT_ID "ok (${#jira_id} chars)"
  note JIRA_CLIENT_SECRET "ok (${#jira_secret} chars)"
elif [[ -z "$jira_id" && -z "$jira_secret" ]]; then
  note JIRA_CLIENT_ID "unset — Jira connect routes stay unmounted (optional)"
  note JIRA_CLIENT_SECRET "unset"
else
  note JIRA_CLIENT_ID "$([[ -n "$jira_id" ]] && echo "set (${#jira_id} chars)" || echo EMPTY)"
  note JIRA_CLIENT_SECRET "$([[ -n "$jira_secret" ]] && echo "set (${#jira_secret} chars)" || echo EMPTY)"
  echo "  -> set both or neither: jiraOAuthConfig needs the pair." >&2
  fail=1
fi

# --- Sizing provider: optional, and both values or neither -----------------
anthropic_key="$(read_value ANTHROPIC_API_KEY || true)"
sizing_model="$(read_value SIZING_MODEL || true)"
[[ "$anthropic_key" == REPLACE_ME ]] && anthropic_key=""
[[ "$sizing_model" == REPLACE_ME ]] && sizing_model=""

deepseek_key="$(read_value DEEPSEEK_API_KEY || true)"
deepseek_model="$(read_value DEEPSEEK_SIZING_MODEL || true)"
[[ "$deepseek_key" == REPLACE_ME ]] && deepseek_key=""
[[ "$deepseek_model" == REPLACE_ME ]] && deepseek_model=""

anthropic_pair=0
[[ -n "$anthropic_key" && -n "$sizing_model" ]] && anthropic_pair=1
deepseek_pair=0
[[ -n "$deepseek_key" && -n "$deepseek_model" ]] && deepseek_pair=1

if (( anthropic_pair )); then
  note ANTHROPIC_API_KEY "ok (${#anthropic_key} chars)"
  note SIZING_MODEL "ok (${#sizing_model} chars)"
elif [[ -z "$anthropic_key" && -z "$sizing_model" ]]; then
  if (( deepseek_pair )); then
    note ANTHROPIC_API_KEY "unset — DeepSeek serves sizing alone (optional)"
  else
    note ANTHROPIC_API_KEY "unset — bounty sizing stays unavailable (optional)"
  fi
  note SIZING_MODEL "unset"
else
  note ANTHROPIC_API_KEY "$([[ -n "$anthropic_key" ]] && echo "set (${#anthropic_key} chars)" || echo EMPTY)"
  note SIZING_MODEL "$([[ -n "$sizing_model" ]] && echo "set (${#sizing_model} chars)" || echo EMPTY)"
  echo "  -> set both or neither: sizingConfig needs the pair." >&2
  fail=1
fi

# The fallback pair, on the same rule. With both pairs set it answers whenever
# an Anthropic call fails; on its own it serves sizing outright.
if (( deepseek_pair )); then
  note DEEPSEEK_API_KEY "ok (${#deepseek_key} chars)"
  note DEEPSEEK_SIZING_MODEL "ok (${#deepseek_model} chars)"
elif [[ -z "$deepseek_key" && -z "$deepseek_model" ]]; then
  note DEEPSEEK_API_KEY "unset — no sizing fallback (optional)"
  note DEEPSEEK_SIZING_MODEL "unset"
else
  note DEEPSEEK_API_KEY "$([[ -n "$deepseek_key" ]] && echo "set (${#deepseek_key} chars)" || echo EMPTY)"
  note DEEPSEEK_SIZING_MODEL "$([[ -n "$deepseek_model" ]] && echo "set (${#deepseek_model} chars)" || echo EMPTY)"
  echo "  -> set both or neither: deepseekSizingConfig needs the pair." >&2
  fail=1
fi

echo
if (( fail )); then
  echo "Not ready. The API validates all of these at boot and will not start." >&2
  exit 1
fi

cat <<'EOF'
Ready to push:

  make secrets-push

Before sign-in works, each provider needs its production redirect URI:

  https://platform.lunox.work/api/auth/callback/google
  https://platform.lunox.work/api/auth/callback/github
  https://platform.lunox.work/api/auth/callback/atlassian
EOF
