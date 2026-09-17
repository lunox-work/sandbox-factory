#!/usr/bin/env bash
#
# Run Drizzle migrations as a one-off ECS task, then wait for the result.
#
#   ./infra/scripts/run-migrations.sh <image-tag>
#
# A separate task, not API boot: on a rolling deploy several API tasks would
# race to apply the same migration and block behind each other's locks.
# packages/db/src/migrate.ts is the CLI this runs.

set -euo pipefail

IMAGE_TAG="${1:?usage: run-migrations.sh <image-tag>}"
PROJECT="${PROJECT:-sandbox-factory}"
REGION="${AWS_REGION:-us-east-1}"
CLUSTER="${CLUSTER:-$PROJECT}"

echo "Running migrations from image tag: $IMAGE_TAG"

# Reuses the API's task definition (same image, secrets, roles) and overrides
# only the command, so it migrates with the code the new API tasks will run.
TASK_DEF="${PROJECT}-api"

SUBNETS="${SUBNETS:?SUBNETS must be set (comma-separated subnet ids)}"
SECURITY_GROUP="${SECURITY_GROUP:?SECURITY_GROUP must be set}"

task_arn="$(aws ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --region "$REGION" \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SECURITY_GROUP],assignPublicIp=ENABLED}" \
  --overrides "$(cat <<JSON
{
  "containerOverrides": [{
    "name": "api",
    "command": ["npm", "run", "db:migrate", "--workspace", "@sandbox-factory/db"]
  }]
}
JSON
)" \
  --query 'tasks[0].taskArn' \
  --output text)"

if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "Failed to start the migration task." >&2
  exit 1
fi

echo "Task started: ${task_arn##*/}"
echo "Waiting for it to finish..."

aws ecs wait tasks-stopped \
  --cluster "$CLUSTER" \
  --tasks "$task_arn" \
  --region "$REGION"

# Stopped is not succeeded: only the container's exit code says whether the
# migration applied.
exit_code="$(aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks "$task_arn" \
  --region "$REGION" \
  --query 'tasks[0].containers[0].exitCode' \
  --output text)"

stopped_reason="$(aws ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks "$task_arn" \
  --region "$REGION" \
  --query 'tasks[0].stoppedReason' \
  --output text)"

echo
echo "--- migration logs ---"
aws logs get-log-events \
  --log-group-name "/ecs/${PROJECT}-api" \
  --log-stream-name "api/api/${task_arn##*/}" \
  --region "$REGION" \
  --query 'events[].message' \
  --output text 2>/dev/null || echo "(logs not yet available)"
echo "--- end logs ---"
echo

if [[ "$exit_code" != "0" ]]; then
  echo "Migrations FAILED (exit code: $exit_code, reason: $stopped_reason)" >&2
  echo "The deploy stops here — the schema was not changed." >&2
  exit 1
fi

echo "Migrations applied."
