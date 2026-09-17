#!/usr/bin/env bash
#
# Confirm the running site is serving the commit we just deployed.
#
#   ./infra/scripts/verify-deploy.sh <expected-sha> [url] [expected-digest]
#
# This is the step that makes the deploy honest. ECS reporting a stable service
# means containers are running and passing health checks — it does not mean they
# are running the image you just built. Asking the site itself closes that gap.
#
# Two fields are checked, and they are not equally strong. `gitSha` is a value
# CD injected into the task definition and the server repeats back, so matching
# it proves the rollout completed — it cannot prove much more, because both
# sides of the comparison originate here. `imageDigest` is read by the server
# from the container runtime's own metadata, so matching it proves the bytes
# running are the bytes this deploy pushed. The digest is the one an outside
# party can look the signed provenance statement up by, and check without
# trusting any of this.
#
# It works because of machinery the repo already has: docs/versioning.md
# describes the BUILD_SHA injection, apps/api/src/env.ts reads it at boot, and
# GET /version returns it unauthenticated — the route's own comment anticipates
# deploy tooling reading it without credentials.

set -euo pipefail

EXPECTED_SHA="${1:?usage: verify-deploy.sh <expected-sha> [url] [expected-digest]}"
URL="${2:-https://platform.lunox.work}"
# Optional: older deployments and any non-ECS target report no digest. Unset,
# the digest check is skipped rather than failed — this script has to keep
# working against an instance predating the field.
EXPECTED_DIGEST="${3:-}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"
INTERVAL=10

echo "Verifying deployment at $URL"
echo "  expecting sha: $EXPECTED_SHA"
if [[ -n "$EXPECTED_DIGEST" ]]; then
  echo "  expecting digest: $EXPECTED_DIGEST"
fi

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
      if [[ -z "$EXPECTED_DIGEST" ]]; then
        echo
        echo "Verified: the site is serving $EXPECTED_SHA"
        printf '%s\n' "$response"
        exit 0
      fi

      actual_digest="$(printf '%s' "$response" \
        | sed -n 's/.*"imageDigest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"

      if [[ "$actual_digest" == "$EXPECTED_DIGEST" ]]; then
        echo
        echo "Verified: the site is serving $EXPECTED_SHA"
        echo "Verified: running image digest matches what this deploy pushed"
        echo
        echo "  Anyone can check where those bytes came from, without trusting us:"
        echo "    gh api /repos/lunox-work/sandbox-factory/attestations/$actual_digest"
        printf '%s\n' "$response"
        exit 0
      fi

      # The sha matches while the digest does not. Worth failing loudly rather
      # than passing on the weaker of the two checks: it means something is
      # serving a different image than the one this deploy pushed while still
      # claiming this commit — a stale task the rollout did not replace, or a
      # tag pointing at bytes other than the ones built here.
      if [[ -n "$actual_digest" ]]; then
        echo >&2
        echo "Verification FAILED: sha matches but the image digest does not." >&2
        echo "  expected: $EXPECTED_DIGEST" >&2
        echo "  serving:  $actual_digest" >&2
        echo >&2
        echo "The running image is not the one this deploy pushed, even though it" >&2
        echo "reports this commit. Check for a task that did not get replaced:" >&2
        echo "  aws ecs describe-services --cluster sandbox-factory --services sandbox-factory-api" >&2
        exit 1
      fi

      printf '  attempt %d: serving %s, digest not reported yet\n' \
        "$attempt" "${actual:0:7}"
      sleep "$INTERVAL"
      continue
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
