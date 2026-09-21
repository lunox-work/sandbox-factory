#!/usr/bin/env bash
#
# Generate .env.production, ready for the Neon connection string.
#
#   ./infra/scripts/secrets-template.sh [--force]
#
# Copies the six OAuth values from .env.development when present (blank
# otherwise, to fill in by hand) and generates a fresh BETTER_AUTH_SECRET: dev
# and production must never share a session-signing key.
#
# Refuses to overwrite an existing file without --force; it may hold the only
# copy of a rotated credential.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SRC="$ROOT/.env.development"
OUT="$ROOT/.env.production"

[[ "${1:-}" == "--force" ]] || if [[ -f "$OUT" ]]; then
  echo "$OUT already exists." >&2
  echo "Re-generating would discard what is in it. Pass --force if that is what you want." >&2
  exit 1
fi

[[ -f "$SRC" ]] || { echo "No $SRC to copy OAuth values from." >&2; exit 1; }

value_of() {
  local line; line="$(grep -E "^$1=" "$SRC" | tail -1 || true)"
  [[ -z "$line" ]] && return 1
  local v="${line#*=}"
  if [[ "$v" =~ ^\"(.*)\"$ ]] || [[ "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  printf '%s' "$v"
}

# Absent OAuth values are expected, not an error. `make secrets-check` is what
# refuses an incomplete file.
for k in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET GITHUB_CLIENT_ID \
         GITHUB_CLIENT_SECRET ATLASSIAN_CLIENT_ID ATLASSIAN_CLIENT_SECRET \
         JIRA_CLIENT_ID JIRA_CLIENT_SECRET ANTHROPIC_API_KEY SIZING_MODEL; do
  value_of "$k" >/dev/null || echo "note: $k is empty in $SRC — fill it in $OUT by hand" >&2
done

SECRET="$(openssl rand -base64 32)"
# Same reasoning as the signing key: generated fresh, never copied from a dev
# machine. Unlike it, losing this one makes the stored Jira tokens unreadable,
# so every connection has to be made again.
TOKEN_KEY="$(openssl rand -base64 32)"

# umask before creation, so the file is never briefly world-readable.
#
# The body mirrors .env.example key for key, in order, with unset keys
# commented out, so the env files stay diffable against each other.
( umask 077; cat > "$OUT" <<EOF
# Production configuration for platform.lunox.work.
#
#   make secrets-template   regenerates this file
#   make secrets-check      validates it the way the API does at boot
#   make secrets-push       writes the active values to AWS Secrets Manager
#
# Gitignored, like .env.development. Nothing reads it at runtime — Secrets
# Manager does.
# It follows the shape of .env.example section for section, so the two diff
# cleanly; keys this environment does not set are commented with the reason.

# ---- api ------------------------------------------------------------------

# Set by the ECS task definition (infra/ecs.tf), not from here.
# PORT=4000
# CORS_ORIGINS=https://platform.lunox.work

# Required. Neon, not RDS — so this is a credential you hold rather than one
# Terraform assembles. Must carry ?sslmode=require or Neon refuses the
# connection. Prefer the pooled endpoint (host contains \`-pooler\`).
DATABASE_URL=

# ---- auth -----------------------------------------------------------------
#
# All of these are required; the API will not boot without them.
#
# Signing secret for session tokens. Generated fresh for production rather than
# copied from .env.development — a dev machine and production must not share a
# signing key.
# Rotating it signs everyone out, which is the intended way to do that.
BETTER_AUTH_SECRET=$SECRET

# Encrypts the Jira tokens in `jira_connection` (AES-256-GCM). The API refuses
# to start without it, so that no token is ever written unencrypted.
# Rotating it means re-encrypting those rows: `key_id` records which key wrote
# each one, so both keys can be readable while that runs.
TOKEN_ENCRYPTION_KEY=$TOKEN_KEY

# Public origin of the API. Set by the ECS task definition, which derives it
# from var.domain_name so the two cannot drift apart.
# BETTER_AUTH_URL=https://platform.lunox.work

# Public origin of the web app. Same origin as the API here, because CloudFront
# serves the SPA and /api/* from one hostname. Set by the task definition.
# APP_URL=https://platform.lunox.work

# Google: https://console.cloud.google.com/apis/credentials
# Add this redirect URI alongside the localhost one — Google accepts several:
#   https://platform.lunox.work/api/auth/callback/google
GOOGLE_CLIENT_ID=$(value_of GOOGLE_CLIENT_ID)
GOOGLE_CLIENT_SECRET=$(value_of GOOGLE_CLIENT_SECRET)

# GitHub: https://github.com/settings/developers
# A GitHub OAuth App accepts exactly ONE callback URL, unlike the other two.
# Copied from .env.development when present; empty otherwise —
# production needs either that app repointed at the URL below, or a second app
# whose values replace these:
#   https://platform.lunox.work/api/auth/callback/github
GITHUB_CLIENT_ID=$(value_of GITHUB_CLIENT_ID)
GITHUB_CLIENT_SECRET=$(value_of GITHUB_CLIENT_SECRET)

# Atlassian, app 1 of 2: sign-in.
# https://developer.atlassian.com/console/myapps/
# Under Authorization > OAuth 2.0 (3LO) > Configure, add this callback URL
# alongside the localhost one:
#   https://platform.lunox.work/api/auth/callback/atlassian
#
# "User Identity API" with \`read:me\` only. Do NOT add the Jira APIs here:
# a grant is per app and a new grant overwrites the previous one's scopes, so
# one app serving both flows would make signing in and connecting Jira break
# each other. See apps/api/src/auth.ts for the trustedProviders consequence.
ATLASSIAN_CLIENT_ID=$(value_of ATLASSIAN_CLIENT_ID)
ATLASSIAN_CLIENT_SECRET=$(value_of ATLASSIAN_CLIENT_SECRET)

# Atlassian, app 2 of 2: connecting a client's Jira site.
# A separate 3LO app, for the reason above. Name it so a client recognises it
# on the consent screen — this is the app they grant access to their tickets.
#
# Authorization > OAuth 2.0 (3LO) > Configure, alongside the localhost one:
#   https://platform.lunox.work/api/v1/jira/callback
# Note the path: this flow is the API's own, not Better Auth's.
#
# Permissions > "Jira API", granting exactly READ_SCOPES from
# packages/jira/src/oauth.ts: read:jira-work and read:jira-user (classic),
# plus read:board-scope:jira-software and read:sprint:jira-software, which are
# on the console's GRANULAR scopes tab — Jira Software has no classic scopes,
# so they are absent from the classic list and look missing. Without them the
# agile endpoints answer 404, which reads like a missing board.
JIRA_CLIENT_ID=$(value_of JIRA_CLIENT_ID)
JIRA_CLIENT_SECRET=$(value_of JIRA_CLIENT_SECRET)

# Optional bounty sizing. The model remains explicit so a deploy cannot change
# model behavior merely by updating application code.
ANTHROPIC_API_KEY=$(value_of ANTHROPIC_API_KEY)
SIZING_MODEL=$(value_of SIZING_MODEL)

# Left unset deliberately. The SPA and the API share one origin through
# CloudFront, so the session cookie stays host-only — which is stricter than
# scoping it to .lunox.work, where any other subdomain could read it.
# AUTH_COOKIE_DOMAIN=.lunox.work

# ---- origin verification --------------------------------------------------
#
# Terraform generates this (random_password.origin_verify in infra/discovery.tf)
# and injects it into both the task definition and the CloudFront origin config,
# so the two always agree. Setting it here would have no effect and would risk
# the two drifting apart.
#
# It matters in this deployment: there is no load balancer, so the task's port
# is open to the internet and this header is what separates a CDN request from
# a stranger who resolved the origin record.
# ORIGIN_VERIFY=

# ---- object storage (SeaweedFS S3 gateway) --------------------------------
#
# Unset in production, and correctly so: nothing in the API consumes object
# storage yet (packages/db/src/objects.ts is written and tested but has no
# caller), and env.ts treats the whole group as optional.
#
# When a feature needs it, the target is an S3 bucket rather than SeaweedFS —
# the code is not SeaweedFS-specific — and these move to Secrets Manager
# alongside the rest, with S3_ENDPOINT left unset so the SDK uses AWS directly.

# S3_ENDPOINT=
# S3_BUCKET=sandbox-factory
# S3_ACCESS_KEY_ID=
# S3_SECRET_ACCESS_KEY=
# S3_REGION=us-east-1

# ---- compose port overrides -----------------------------------------------
# Local-only. Docker Compose does not run in production; the ECS task listens
# on the port the task definition gives it.

# POSTGRES_PORT=5432
# S3_PORT=8333
# SEAWEED_FILER_PORT=8888
# API_PORT=4000
# WEB_PORT=5173
# WEB_PROD_PORT=8080
EOF
)

chmod 600 "$OUT"
echo "Wrote $OUT (mode 600)"
echo
echo "Next: paste your Neon connection string into DATABASE_URL, then"
echo "  make secrets-check"
