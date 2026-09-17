# IAM roles.
#
# Two roles for the task, which is an AWS distinction worth keeping straight:
#
#   execution role — used by the ECS *agent*, before the container starts, to
#                    pull the image and resolve secrets into the environment.
#   task role      — used by the *application*, at runtime, for anything it
#                    calls the AWS API for.
#
# The task role is deliberately almost empty. The API reads its secrets through
# the execution role at startup, so the running process needs no AWS permissions
# at all today. The role exists so that wiring up the S3 object store in
# packages/db/src/objects.ts is a policy attachment rather than a redesign.

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Scoped to exactly the secrets this project owns, rather than a wildcard:
# the execution role should be able to read the API's credentials and nothing
# else in the account.
data "aws_iam_policy_document" "read_secrets" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.app : s.arn]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "read-app-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.read_secrets.json
}

resource "aws_iam_role" "task" {
  name               = "${local.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
