# A role anyone may assume to read which image production is running.
#
# Why this exists. The provenance chain in docs/versioning.md starts at `GET
# /version`, which the API reports about itself. Every later link is checkable
# against a public transparency log, but that first one is not: a server that
# had been replaced could report an honest image's digest. Reading the digest
# from the ECS control plane instead removes this project from the chain
# entirely — the answer comes from AWS, and the caller trusts AWS rather than us.
#
# Opt-in, and off by default. `sts:AssumeRole` with a `*` principal means any
# AWS account on earth can assume this role, which is the point and is also not
# a thing to switch on by accident. Enable it with:
#
#   audit_role_public = true    (infra/terraform.tfvars)
#
# What an assumer can do is three read-only calls against this one cluster. No
# describe-task-definition: the task definition carries ORIGIN_VERIFY in plain
# text, so it stays out of reach even though this role is read-only. The
# digest is in DescribeTasks, which does not.

variable "audit_role_public" {
  description = "Let anyone assume the audit role to read the running image digest from AWS. Off by default: it is world-assumable by design."
  type        = bool
  default     = false
}

# Deliberately not bounded by ExternalId or a principal list. An audit path that
# requires us to hand out a credential first is one we could quietly withhold
# from the person asking, which defeats the purpose.
data "aws_iam_policy_document" "audit_assume" {
  count = var.audit_role_public ? 1 : 0

  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }
  }
}

resource "aws_iam_role" "audit" {
  count = var.audit_role_public ? 1 : 0

  name               = "${local.name}-public-audit"
  description        = "Assumable by anyone. Reads which image the API service is running, and nothing else."
  assume_role_policy = data.aws_iam_policy_document.audit_assume[0].json

  # One hour, which is the AWS minimum for this field. A caller wanting less
  # can pass a shorter --duration-seconds; there is nothing worth protecting in
  # a session that can make three read-only calls.
  max_session_duration = 3600

  tags = local.tags
}

data "aws_iam_policy_document" "audit" {
  count = var.audit_role_public ? 1 : 0

  # ListTasks and DescribeTasks take no resource, so the cluster condition is
  # what confines them. Without it this would read every task in the account.
  statement {
    sid       = "ReadRunningTasks"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks"]
    resources = ["*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  # So a caller can confirm the digest they were given is one this project
  # pushed, and see when. Read-only, and the repository is one image.
  statement {
    sid       = "ReadImageMetadata"
    actions   = ["ecr:DescribeImages"]
    resources = [aws_ecr_repository.api.arn]
  }

  # Everything else, explicitly. An IAM role with a `*` principal is exactly
  # where a later policy attachment would do the most damage, so the deny
  # covers the whole account surface: logs, secrets, the database, the state
  # bucket, and reading the task definition this service runs.
  statement {
    sid    = "DenyEverythingElse"
    effect = "Deny"
    not_actions = [
      "ecs:ListTasks",
      "ecs:DescribeTasks",
      "ecr:DescribeImages",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "audit" {
  count = var.audit_role_public ? 1 : 0

  name   = "read-running-image"
  role   = aws_iam_role.audit[0].id
  policy = data.aws_iam_policy_document.audit[0].json
}

output "audit_role_arn" {
  description = "Role anyone may assume to read the running image digest from AWS. Empty unless audit_role_public is set. Publish it in SECURITY.md."
  value       = var.audit_role_public ? aws_iam_role.audit[0].arn : ""
}
