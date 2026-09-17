#!/usr/bin/env bash
#
# Push secret values from a local .env.production into AWS Secrets Manager.
#
# This is the other half of the rule that secrets.tf follows: Terraform creates
# the containers, this fills them. No secret value ever passes through Terraform,
# so none of them lands in terraform.tfstate or in this public repository.
#
#   ./infra/scripts/secrets-push.sh [path-to-env-file]
#
# Defaults to .env.production at the repo root. That filename is covered by the
# existing `.env.*` rule in .gitignore, so it cannot be committed by accident.
#
# Safe to re-run: it overwrites values, which is exactly how you rotate one.
#
# DATABASE_URL is in the list: Postgres is Neon, outside AWS, so its connection
# string is a credential you hold rather than something Terraform assembles. It
# must include ?sslmode=require — Neon refuses an unencrypted connection.

set -euo pipefail

PROJECT="${PROJECT:-sandbox-factory}"
REGION="${AWS_REGION:-us-east-1}"
ENV_FILE="${1:-$(git rev-parse --show-toplevel)/.env.production}"

# Exactly the keys secrets.tf creates. A key here with no matching secret is a
# mistake worth failing on, not silently skipping.
KEYS=(
  DATABASE_URL
  BETTER_AUTH_SECRET
  GOOGLE_CLIENT_ID
  GOOGLE_CLIENT_SECRET
  GITHUB_CLIENT_ID
  GITHUB_CLIENT_SECRET
  ATLASSIAN_CLIENT_ID
  ATLASSIAN_CLIENT_SECRET
)

if [[ ! -f "$ENV_FILE" ]]; then
  cat >&2 <<EOF
No env file at: $ENV_FILE

Create one from the template and fill in production values:

  cp .env.example .env.production

It needs the eight keys below. Everything else in .env.example is set by the
task definition (PORT, CORS_ORIGINS, BETTER_AUTH_URL, ORIGIN_VERIFY):

$(printf '  %s\n' "${KEYS[@]}")
EOF
  exit 1
fi

# Read one key's value from the env file without sourcing it. Sourcing would
# execute whatever the file contains, and a stray backtick in a secret would run
# as a command.
read_value() {
  local key="$1"
  # Last occurrence wins, matching how dotenv loaders behave.
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  [[ -z "$line" ]] && return 1
  local value="${line#*=}"
  # Strip one layer of matching quotes, if present.
  if [[ "$value" =~ ^\"(.*)\"$ ]] || [[ "$value" =~ ^\'(.*)\'$ ]]; then
    value="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$value"
}

echo "Pushing secrets to AWS Secrets Manager"
echo "  account: $(aws sts get-caller-identity --query Account --output text)"
echo "  region:  $REGION"
echo "  source:  $ENV_FILE"
echo

missing=()
pushed=0

# Two passes, deliberately. Writing as we read would leave Secrets Manager
# half-rotated when a value near the end turns out to be missing — some secrets
# new, some old, and an API that boots with a mix of both. Validate everything
# first, then write.
declare -a values=()
for key in "${KEYS[@]}"; do
  if ! value="$(read_value "$key")" || [[ -z "$value" ]]; then
    missing+=("$key")
    values+=("")
    continue
  fi
  if [[ "$value" == "REPLACE_ME" || "$value" == replace-me* ]]; then
    missing+=("$key")
    values+=("")
    continue
  fi
  values+=("$value")
done

if ((${#missing[@]} > 0)); then
  echo "Incomplete — nothing was written:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "The API validates every one of these at boot and will not start without them." >&2
  echo "Generate a signing secret with: openssl rand -base64 32" >&2
  exit 1
fi

for i in "${!KEYS[@]}"; do
  key="${KEYS[$i]}"
  value="${values[$i]}"

  # Mirrors the naming in secrets.tf: BETTER_AUTH_SECRET -> better-auth-secret.
  secret_id="${PROJECT}/$(echo "$key" | tr '[:upper:]_' '[:lower:]-')"

  # --secret-string on stdin via file:///dev/stdin keeps the value out of the
  # process list, where `ps` would otherwise show it to any user on the machine.
  if printf '%s' "$value" | aws secretsmanager put-secret-value \
      --secret-id "$secret_id" \
      --secret-string file:///dev/stdin \
      --region "$REGION" >/dev/null 2>&1; then
    printf '  %-26s ok (%d chars)\n' "$key" "${#value}"
    pushed=$((pushed + 1))
  else
    printf '  %-26s FAILED — does the secret exist? Run terraform apply first.\n' "$key"
    exit 1
  fi
done

echo
echo "Pushed $pushed secrets."
echo
echo "Restart the API so it picks them up:"
echo "  aws ecs update-service --cluster $PROJECT --service ${PROJECT}-api \\"
echo "    --force-new-deployment --region $REGION"
