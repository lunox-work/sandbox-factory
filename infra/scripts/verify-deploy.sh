#!/usr/bin/env bash
#
# Confirm the running site is serving the commit we just deployed.
#
#   ./infra/scripts/verify-deploy.sh <expected-sha> [url]
#
# This is the step that makes the deploy honest. ECS reporting a stable service
# means containers are running and passing health checks — it does not mean they
# are running the image you just built. Asking the site itself closes that gap.
#
# It works because of machinery the repo already has: docs/versioning.md
# describes the BUILD_SHA injection, apps/api/src/env.ts reads it at boot, and
# GET /version returns it unauthenticated — the route's own comment anticipates
# deploy tooling reading it without credentials.

set -euo pipefail

EXPECTED_SHA="${1:?usage: verify-deploy.sh <expected-sha> [url]}"
URL="${2:-https://platform.lunox.work}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"
INTERVAL=10

echo "Verifying deployment at $URL"
echo "  expecting sha: $EXPECTED_SHA"

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
attempt=0

while (( $(date +%s) < deadline )); do
  attempt=$((attempt + 1))

  # --fail-with-body would be neater but is curl 7.76+; this keeps the script
  # portable across the runner images.
  if response="$(curl -fsS --max-time 10 "$URL/version" 2>/dev/null)"; then
    # Avoids a jq dependency on the runner: the field is a flat string.
    actual="$(printf '%s' "$response" | sed -n 's/.*"gitSha"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

    if [[ "$actual" == "$EXPECTED_SHA" ]]; then
      echo
      echo "Verified: the site is serving $EXPECTED_SHA"
      printf '%s\n' "$response"
      exit 0
    fi

    printf '  attempt %d: serving %s (waiting for %s)\n' \
      "$attempt" "${actual:0:7}" "${EXPECTED_SHA:0:7}"
  else
    printf '  attempt %d: no response yet\n' "$attempt"
  fi

  sleep "$INTERVAL"
done

echo >&2
echo "Verification FAILED after ${TIMEOUT_SECONDS}s." >&2
echo "The site is not serving $EXPECTED_SHA." >&2
echo >&2
echo "The ECS circuit breaker rolls the service back automatically on a failed" >&2
echo "deploy. Check what is actually running:" >&2
echo "  curl -s $URL/version" >&2
echo "  aws logs tail /ecs/sandbox-factory-api --since 10m" >&2
exit 1
