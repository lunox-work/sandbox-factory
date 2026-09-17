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
