#!/usr/bin/env bash
#
# Confirm the running site is serving the commit we just deployed.
#
#   ./infra/scripts/verify-deploy.sh <expected-sha> [url] [expected-digest]
#
# A stable ECS service means tasks pass health checks, not that they run the
# image just built, so ask the site itself via the unauthenticated GET /version.
#
# `gitSha` is injected by CD and echoed back, so a match only proves the
# rollout completed. `imageDigest` comes from the container runtime's metadata,
# so a match proves the running bytes are the ones this deploy pushed; it is
# also the key to the signed provenance attestation. See docs/versioning.md.

set -euo pipefail

EXPECTED_SHA="${1:?usage: verify-deploy.sh <expected-sha> [url] [expected-digest]}"
URL="${2:-https://platform.lunox.work}"
# Optional: older deployments and non-ECS targets report no digest. Unset
# skips the digest check rather than failing it.
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

  # Not --fail-with-body: it needs curl 7.76+.
  if response="$(curl -fsS --max-time 10 "$URL/version" 2>/dev/null)"; then
    # sed, not jq: the field is a flat string and the runner may lack jq.
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

      # Sha matches but the digest does not: a stale task the rollout did not
      # replace, or a tag pointing at other bytes. Fail rather than pass on the
      # weaker check.
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
