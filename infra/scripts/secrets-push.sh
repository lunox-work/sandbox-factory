#!/usr/bin/env bash
#
# Push secret values from a local .env.production into AWS Secrets Manager.
#
#   ./infra/scripts/secrets-push.sh [path-to-env-file] [--only KEY]...
#
# Terraform (secrets.tf) creates the containers; this fills them, so no secret
# value ever reaches terraform.tfstate. Defaults to the gitignored
# .env.production at the repo root. Safe to re-run: overwriting is how a value
# is rotated.

set -euo pipefail

PROJECT="${PROJECT:-sandbox-factory}"
REGION="${AWS_REGION:-us-east-1}"
# --only KEY (repeatable) pushes just the named keys. A local .env.production
# can hold stale values for the others, and pushing those would overwrite live
# credentials.
ONLY_KEYS=()
ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ -n "${2:-}" ]] || { echo "--only needs a key name" >&2; exit 1; }
      ONLY_KEYS+=("$2"); shift 2 ;;
    --only=*)
      ONLY_KEYS+=("${1#*=}"); shift ;;
    -*)
      echo "unknown flag: $1" >&2; exit 1 ;;
    *)
      [[ -z "$ENV_FILE" ]] || { echo "more than one env file given" >&2; exit 1; }
      ENV_FILE="$1"; shift ;;
  esac
done
ENV_FILE="${ENV_FILE:-$(git rev-parse --show-toplevel)/.env.production}"

# Exactly the keys secrets.tf creates; a key with no matching secret fails the
# push. Keep in step with SECRET_KEYS in scripts/rotate-token.sh.
KEYS=(
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
  DEEPSEEK_API_KEY
  DEEPSEEK_SIZING_MODEL
)

# Pairs a deployment may leave out entirely: each is a feature that is off
# until both halves exist. A full push skips a pair with neither value, rather
# than failing, and still refuses one with only half. Naming a key in --only
# always requires its value.
OPTIONAL_PAIRS=(
  "JIRA_CLIENT_ID JIRA_CLIENT_SECRET"
  "ANTHROPIC_API_KEY SIZING_MODEL"
  "DEEPSEEK_API_KEY DEEPSEEK_SIZING_MODEL"
)

in_list() {
  local want="$1" item
  shift
  for item in "$@"; do [[ "$item" == "$want" ]] && return 0; done
  return 1
}

# Narrow to the requested keys, rejecting unknown ones.
if ((${#ONLY_KEYS[@]} > 0)); then
  for want in "${ONLY_KEYS[@]}"; do
    printf '%s\n' "${KEYS[@]}" | grep -qx -- "$want" \
      || { echo "--only: $want is not one of the secret keys" >&2; exit 1; }
  done
  declare -a selected=()
  for key in "${KEYS[@]}"; do
    printf '%s\n' "${ONLY_KEYS[@]}" | grep -qx -- "$key" && selected+=("$key")
  done
  KEYS=("${selected[@]}")
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cat >&2 <<EOF
No env file at: $ENV_FILE

Create one from the template and fill in production values:

  cp .env.example .env.production

It needs the keys below. Everything else in .env.example is set by the task
definition (PORT, CORS_ORIGINS, BETTER_AUTH_URL, ORIGIN_VERIFY):

$(printf '  %s\n' "${KEYS[@]}")
EOF
  exit 1
fi

# Read one key without sourcing the file, which would execute a stray backtick
# in a secret.
read_value() {
  local key="$1"
  # Last occurrence wins, matching how dotenv loaders behave.
  local line
  line="$(grep -E "^${key}=" "$ENV_FILE" | tail -1 || true)"
  [[ -z "$line" ]] && return 1
  local value="${line#*=}"
  # Strip one layer of matching quotes.
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

# Two passes: validate everything, then write. Writing while reading would
# leave Secrets Manager half-rotated when a later value turns out missing.
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

skipped=()
if ((${#ONLY_KEYS[@]} == 0 && ${#missing[@]} > 0)); then
  for pair in "${OPTIONAL_PAIRS[@]}"; do
    read -r first second <<<"$pair"
    if in_list "$first" "${missing[@]}" && in_list "$second" "${missing[@]}"; then
      skipped+=("$first" "$second")
    fi
  done
  if ((${#skipped[@]} > 0)); then
    still_missing=()
    for key in "${missing[@]}"; do
      in_list "$key" "${skipped[@]}" || still_missing+=("$key")
    done
    missing=(${still_missing[@]+"${still_missing[@]}"})
  fi
fi

if ((${#missing[@]} > 0)); then
  echo "Incomplete — nothing was written:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  echo >&2
  echo "Every key named in a push must have a value; nothing empty is written." >&2
  echo "Generate a signing or encryption key with: openssl rand -base64 32" >&2
  echo >&2
  echo "Optional pairs, each all-or-nothing: JIRA_CLIENT_ID/_SECRET," >&2
  echo "ANTHROPIC_API_KEY/SIZING_MODEL and DEEPSEEK_API_KEY/DEEPSEEK_SIZING_MODEL." >&2
  echo "A full push skips a pair with neither value; fill in the other half of" >&2
  echo "a partial one, or drop it from --only rather than pushing a blank." >&2
  exit 1
fi

for i in "${!KEYS[@]}"; do
  key="${KEYS[$i]}"
  value="${values[$i]}"

  if ((${#skipped[@]} > 0)) && in_list "$key" "${skipped[@]}"; then
    printf '  %-26s skipped (optional pair, both unset)\n' "$key"
    continue
  fi

  # Mirrors the naming in secrets.tf: BETTER_AUTH_SECRET -> better-auth-secret.
  secret_id="${PROJECT}/$(echo "$key" | tr '[:upper:]_' '[:lower:]-')"

  # file:///dev/stdin keeps the value out of the process list (`ps`).
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
