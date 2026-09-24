# IAM roles for the task.
#
#   execution role — used by the ECS *agent*, before the container starts, to
#                    pull the image and resolve secrets into the environment.
#   task role      — used by the *application*, at runtime, for AWS API calls.
#
# Secrets arrive through the execution role, so the task role's only grant is
# the object store: avatars in the private bucket (s3.tf).

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

# Only this project's secrets, not a wildcard.
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

# Avatars only: the prefix the API writes. `ListBucket` is on the bucket, not
# the prefix, and carries no prefix condition on purpose — without it S3
# answers a missing key with 403 instead of 404, and `isNotFound` in
# packages/db/src/objects.ts would turn every never-uploaded avatar into a 500.
# A GET that misses carries no `s3:prefix`, so a condition would not match.
data "aws_iam_policy_document" "task_objects" {
  statement {
    sid       = "AvatarObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.private.arn}/avatars/*"]
  }

  statement {
    sid       = "MissingKeyIs404"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.private.arn]
  }
}

resource "aws_iam_role_policy" "task_objects" {
  name   = "avatar-objects"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task_objects.json
}
