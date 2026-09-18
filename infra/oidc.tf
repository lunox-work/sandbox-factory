# GitHub Actions deploy identity: OIDC, no access keys. The token is short-lived
# and its `sub` claim pins one repository and one branch, so it cannot be
# replayed from a fork, a pull request, or another branch.

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # Required field, but not load-bearing: AWS validates this issuer against
  # its own trust store.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

variable "create_oidc_provider" {
  description = "Create the GitHub OIDC provider. Set false if the account already has one — it is account-wide and can exist only once."
  type        = bool
  default     = true
}

locals {
  oidc_provider_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

# The repository has GitHub's immutable subject claims enabled, so `sub` is
# `repo:owner@<org id>/name@<repo id>:...` and the plain `repo:owner/name` form
# never matches. Read it back with:
#   gh api repos/<owner>/<repo>/actions/oidc/customization/sub
variable "github_sub_prefix" {
  description = "Immutable OIDC subject prefix for this repository. From `gh api repos/OWNER/REPO/actions/oidc/customization/sub`."
  type        = string
  default     = "repo:lunox-work@329222439/sandbox-factory@1375970928"
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The load-bearing condition: a pull request's sub ends `:pull_request`, so
    # a fork's PR cannot assume this role.
    #
    # Two values because a job that declares `environment:` gets
    # `:environment:<name>` in place of the branch ref, and cd.yml declares
    # `environment: production`. Without the second value every CD run fails
    # with "Not authorized to perform sts:AssumeRoleWithWebIdentity". The branch
    # and the environment are both protected, so this does not widen the trust.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "${var.github_sub_prefix}:ref:refs/heads/${var.github_deploy_branch}",
        "${var.github_sub_prefix}:environment:${var.github_deploy_environment}",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  name               = "${local.name}-github-deploy"
  description        = "Assumed by GitHub Actions to deploy main. OIDC only; no access keys."
  assume_role_policy = data.aws_iam_policy_document.github_assume.json
}

# Scoped to this project's resources, so a compromised workflow cannot reach
# the rest of the account.
data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"] # This call takes no resource; AWS requires the wildcard.
  }

  statement {
    sid = "EcrPush"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:BatchGetImage",
      "ecr:CompleteLayerUpload",
      "ecr:DescribeImages",
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.api.arn]
  }

  # cd.yml looks up the registry, bucket and distribution in the live account
  # rather than duplicating their names, so a rename in Terraform cannot strand
  # it. These list calls take no resource, so AWS requires the wildcard; cd.yml
  # filters by name. They expose bucket and distribution names, nothing else.
  statement {
    sid = "DiscoverInfrastructure"
    actions = [
      "s3:ListAllMyBuckets",
      "cloudfront:ListDistributions",
      # The migration step finds the service's subnets and security group by
      # tag before running its one-off task. Describe-only.
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
    ]
    resources = ["*"]
  }

  # Split in two: RegisterTaskDefinition and the Describe/List calls take no
  # resource, so AWS requires "*". The calls that act on a running service do,
  # and are pinned to this project's cluster.
  statement {
    sid = "EcsRead"
    actions = [
      "ecs:DescribeTaskDefinition",
      "ecs:RegisterTaskDefinition",
      "ecs:ListTasks",
      "ecs:DescribeTasks",
    ]
    resources = ["*"]
  }

  statement {
    sid = "EcsDeploy"
    actions = [
      "ecs:DescribeServices",
      "ecs:UpdateService",
      "ecs:RunTask",
    ]
    resources = [
      aws_ecs_service.api.id,
      "arn:aws:ecs:${var.region}:${data.aws_caller_identity.current.account_id}:task-definition/${local.name}-api:*",
    ]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  # Only the two roles this project owns, so the workflow cannot start a task
  # as a more privileged role.
  statement {
    sid     = "PassTaskRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.task_execution.arn,
      aws_iam_role.task.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  statement {
    sid       = "S3Publish"
    actions   = ["s3:PutObject", "s3:DeleteObject", "s3:ListBucket", "s3:GetObject"]
    resources = [aws_s3_bucket.web.arn, "${aws_s3_bucket.web.arn}/*"]
  }

  # Invalidate index.html after a publish.
  statement {
    sid       = "CloudFrontInvalidate"
    actions   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"]
    resources = [aws_cloudfront_distribution.main.arn]
  }

  # So CD can report why a deploy failed, not just that it did.
  statement {
    sid       = "ReadLogs"
    actions   = ["logs:GetLogEvents", "logs:DescribeLogStreams"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}

# ---- plan role (pull requests, read-only) ----------------------------------
#
# The deploy role rejects pull-request tokens, so `terraform plan` on a PR
# needs its own identity: trusted for pull requests from this repository only,
# and read-only.

data "aws_iam_policy_document" "github_plan_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [local.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    # A fork's PR carries the fork's repository in its sub, so this matches
    # only PRs raised from a branch of this repository.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_sub_prefix}:pull_request"]
    }
  }
}

resource "aws_iam_role" "github_plan" {
  name               = "${local.name}-github-plan"
  description        = "Assumed by pull requests to run terraform plan. Read-only."
  assume_role_policy = data.aws_iam_policy_document.github_plan_assume.json
}

# ReadOnlyAccess, not an enumerated list: plan refreshes every resource in
# state, and a hand-written list fails opaquely whenever the stack gains a
# resource type.
resource "aws_iam_role_policy_attachment" "github_plan_readonly" {
  role       = aws_iam_role.github_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# Secret *values* are deliberately out of reach: with GetSecretValue, any PR
# could print production credentials by adding a workflow step. Plan loses
# nothing, because the secret versions carry `ignore_changes = [secret_string]`
# (secrets.tf) and a refreshed value would be discarded. The secret containers
# are still planned; ReadOnlyAccess covers DescribeSecret.

# Addresses the plan role may not refresh. The plan workflow drops them from a
# local copy of the state before planning (never the bucket, which this role
# cannot write). `terraform plan -exclude` postdates the pinned 1.9.8; see
# .github/workflows/terraform.yml.
output "plan_unrefreshable_resources" {
  description = "Resources the read-only plan role cannot refresh, because it is denied their values. The plan workflow excludes them explicitly."
  value       = ["aws_secretsmanager_secret_version.app"]
}

# Defence in depth: an explicit deny overrides any allow a future policy
# attachment might grant.
data "aws_iam_policy_document" "github_plan_deny_secret_values" {
  statement {
    sid       = "DenyReadingProjectSecretValues"
    effect    = "Deny"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "github_plan_deny_secret_values" {
  name   = "deny-secret-values"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_deny_secret_values.json
}

# ReadOnlyAccess covers reading the state file in S3. Locking is not
# configured (see backend.hcl), so plan needs no write to the bucket.
