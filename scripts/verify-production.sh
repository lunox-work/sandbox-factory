#!/usr/bin/env bash
#
# verify-production.sh — check that the live site is running code built from
# this repository, without trusting the people who run it.
#
#   ./scripts/verify-production.sh [url] [--aws]
#
# Needs curl, jq and an authenticated `gh` (2.49+). Nothing private, and no AWS
# account unless you pass --aws.
#
# Two checks, both against signatures in a public transparency log:
#
#   API   GET /version reports the digest of the running image. The same image
#         is public at ghcr.io, so `gh attestation verify` pulls it, re-hashes
#         it, and checks the signed statement saying which commit cd.yml built
#         it from. Read the code at that commit, or pull the image and look.
#
#   Web   Every file the CDN serves is a subject of one signed statement.
#         index.html is verified, then each file the statement lists is
#         downloaded and compared with the hash that was signed.
#
# Both must name the commit /version claims, built by cd.yml from main. A build
# from any other branch or workflow fails here even if it deployed.
#
# One weakness remains, and it is worth stating plainly: the digest comes from
# the server being questioned. A server replaced wholesale could report an
# honest image's digest. Pass --aws to close that — the digest is then read
# from the ECS control plane instead, and the answer comes from AWS rather than
# from us:
#
#   ./scripts/verify-production.sh --aws
#
# That needs the public audit role (infra/audit.tf) to be enabled and its ARN
# in SECURITY.md, plus any AWS account of your own to assume it from. The role
# can make three read-only calls and nothing else.
#
# The rest of what this cannot show is in docs/versioning.md.

set -euo pipefail

USE_AWS=0
args=()
for arg in "$@"; do
  case "$arg" in
    --aws) USE_AWS=1 ;;
    -h | --help)
      sed -n '2,30p' "$0" | sed 's/^#\{0,1\} \{0,1\}//'
      exit 0
      ;;
    *) args+=("$arg") ;;
  esac
done

URL="${args[0]:-https://platform.lunox.work}"
REPO="lunox-work/sandbox-factory"
MIRROR="ghcr.io/lunox-work/sandbox-factory-api"
WORKFLOW="$REPO/.github/workflows/cd.yml"
# Published in SECURITY.md. Assumable by any AWS account; reads the running
# task and nothing else.
AUDIT_ROLE="${AUDIT_ROLE_ARN:-}"
CLUSTER="sandbox-factory"
SERVICE="sandbox-factory-api"
AWS_REGION_="${AWS_REGION:-us-east-1}"

for tool in curl jq gh; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 2; }
done

# sha256sum on Linux, shasum on macOS.
if command -v sha256sum >/dev/null; then
  hash_of() { sha256sum "$1" | cut -d' ' -f1; }
else
  hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# The three constraints every attestation must meet: signed by the deploy
# workflow, from main, at the commit the site claims.
verify() {
  gh attestation verify "$1" \
    --repo "$REPO" \
    --signer-workflow "$WORKFLOW" \
    --source-ref refs/heads/main \
    --source-digest "$sha" \
    --format json
}

failed=0

# ---- what the site claims ---------------------------------------------------

version="$(curl -fsS --max-time 10 "$URL/version")"
sha="$(jq -r '.gitSha // empty' <<<"$version")"
digest="$(jq -r '.imageDigest // empty' <<<"$version")"

echo "$URL claims"
echo "  commit  ${sha:-<none>}"
echo "  image   ${digest:-<none>}"
echo

if [[ -z "$sha" || -z "$digest" ]]; then
  echo "FAIL  /version reports no commit or no image digest; nothing to verify" >&2
  exit 1
fi

# ---- the same question, asked of AWS ----------------------------------------
#
# Optional, and the only step here that does not take the server's word for
# what it is running.
if [[ "$USE_AWS" -eq 1 ]]; then
  echo "AWS: reading the running image from the ECS control plane"
  if [[ -z "$AUDIT_ROLE" ]]; then
    echo "  FAIL  no audit role ARN. Set AUDIT_ROLE_ARN, or take it from SECURITY.md." >&2
    exit 2
  fi
  command -v aws >/dev/null || { echo "  FAIL  missing: aws" >&2; exit 2; }

  creds="$(aws sts assume-role \
    --role-arn "$AUDIT_ROLE" \
    --role-session-name "verify-$(date +%s)" \
    --duration-seconds 900 \
    --query Credentials --output json)"

  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  AWS_ACCESS_KEY_ID="$(jq -r .AccessKeyId <<<"$creds")"
  AWS_SECRET_ACCESS_KEY="$(jq -r .SecretAccessKey <<<"$creds")"
  AWS_SESSION_TOKEN="$(jq -r .SessionToken <<<"$creds")"

  # Every running task's image, from the agent's own view of the container.
  # More than one during a rollout, so each is checked.
  tasks="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" \
    --region "$AWS_REGION_" --query 'taskArns' --output text)"
  if [[ -z "$tasks" || "$tasks" == "None" ]]; then
    echo "  FAIL  no running tasks in $CLUSTER/$SERVICE" >&2
    exit 1
  fi

  # shellcheck disable=SC2086
  running="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks $tasks \
    --region "$AWS_REGION_" \
    --query 'tasks[].containers[?name==`api`].imageDigest' --output text \
    | tr -s '[:space:]' '\n' | grep -v '^$' | sort -u)"

  echo "  running: $(tr '\n' ' ' <<<"$running")"
  if [[ "$running" != "$digest" ]]; then
    failed=1
    echo "  FAIL  AWS reports ${running:-nothing}, but $URL claims $digest"
    echo "        (during a rollout two digests are normal; otherwise the site is"
    echo "         not reporting the image it is running)"
  else
    echo "  ok  AWS agrees the running image is $digest"
  fi
  echo

  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
fi

# ---- the API image ----------------------------------------------------------

echo "API: verifying $MIRROR@$digest"
if verify "oci://$MIRROR@$digest" >"$work/api.json" 2>"$work/api.err"; then
  echo "  ok  signed by cd.yml, from main, at $sha"
else
  failed=1
  echo "  FAIL"
  sed 's/^/      /' "$work/api.err"
  echo "      (an image deployed before the public mirror existed cannot be pulled;"
  echo "       the next deploy mirrors it)"
fi
echo

# ---- the web app ------------------------------------------------------------

echo "Web: verifying $URL/index.html"
curl -fsS --max-time 10 "$URL/index.html" -o "$work/index.html"

if verify "$work/index.html" >"$work/web.json" 2>"$work/web.err"; then
  echo "  ok  index.html signed by cd.yml, from main, at $sha"

  # The files that build produced, from the statement just verified — not from
  # anything the site says about itself.
  jq -r '.[0].verificationResult.statement.subject[]
         | "\(.digest.sha256)  \(.name)"' "$work/web.json" >"$work/subjects.txt"

  count=0
  while read -r expected name; do
    count=$((count + 1))
    if ! curl -fsS --max-time 20 "$URL/$name" -o "$work/file"; then
      failed=1
      echo "  FAIL  $name could not be downloaded"
      continue
    fi
    actual="$(hash_of "$work/file")"
    if [[ "$actual" != "$expected" ]]; then
      failed=1
      echo "  FAIL  $name is $actual, signed as $expected"
    fi
  done <"$work/subjects.txt"
  echo "  checked $count files against the signed statement"
else
  failed=1
  echo "  FAIL"
  sed 's/^/      /' "$work/web.err"
  echo "      (a rollback ships its web app unsigned, as does any deploy older"
  echo "       than web attestation; see docs/versioning.md)"
fi
echo

if [[ "$failed" -eq 0 ]]; then
  echo "Verified: the image and every file served were built by cd.yml from"
  echo "https://github.com/$REPO/tree/$sha"
else
  echo "NOT verified. See the failures above." >&2
  exit 1
fi
