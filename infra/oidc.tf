# GitHub Actions deploy identity.
#
# OIDC, not an access key. This matters more than usual for a public repository:
# a static key in repository secrets is one misconfigured workflow away from
# exposure, and the repo already demonstrates awareness of that class of risk —
# auto-merge.yml refuses to check out PR code precisely because it runs with
# write permissions.
#
# The token GitHub mints here is short-lived and bound by its `sub` claim to one
# repository and one branch, so it cannot be replayed from a fork, from a pull
# request, or from any other branch.

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS validates the provider's certificate chain against its own trust store
  # for this issuer, so this thumbprint is no longer load-bearing; it remains a
  # required field.
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

# This repository has GitHub's *immutable* subject claims enabled, so the `sub`
# in an OIDC token is not `repo:owner/name:...` but
# `repo:owner@<org id>/name@<repo id>:...` — the numeric ids pin the claim to
# this exact repository even if it is renamed or transferred, which is the
# point of the feature and also why the plain-name form never matches.
#
# Read it back with:
#   gh api repos/<owner>/<repo>/actions/oidc/customization/sub
variable "github_sub_prefix" {
  description = "Immutable OIDC subject prefix for this repository. From `gh api repos/OWNER/REPO/actions/oidc/customization/sub`."
  type        = string
  default     = "repo:lunox-work@329222439/sandbox-factory@1370804029"
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

    # The load-bearing condition. A pull request carries `:pull_request` in its
    # sub and so cannot assume this role, which is what keeps a fork's PR out of
    # AWS entirely.
    #
    # Both forms are listed because a job that declares `environment:` gets a
    # *different* sub: GitHub substitutes `:environment:<name>` for the branch
    # ref. cd.yml declares `environment: production` so it can carry a
    # deployment URL and, later, a required reviewer — so without the second
    # value here, every CD run fails at the credentials step with "Not
    # authorized to perform sts:AssumeRoleWithWebIdentity".
    #
    # Listing both keeps the workflow free to use an environment or not. It does
    # not widen the trust: each value still pins the repository and either the
    # main branch or the production environment, both of which are protected.
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

# Scoped to the resources this project owns. Broad enough to deploy, narrow
# enough that a compromised workflow cannot reach the rest of the account.
data "aws_iam_policy_document" "github_deploy" {
  # Push images.
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
      "ecr:DescribeRepositories",
      "ecr:GetDownloadUrlForLayer",
      "ecr:InitiateLayerUpload",
      "ecr:PutImage",
      "ecr:UploadLayerPart",
    ]
    resources = [aws_ecr_repository.api.arn]
  }

  # Find the resources before acting on them.
  #
  # cd.yml reads the registry URI, the bucket name and the distribution id out
  # of the live account rather than having them duplicated in the workflow, so
  # that renaming one in Terraform cannot leave CD pointing at something that
  # no longer exists. That design needs the discovery calls as well as the
  # actions above: permission to push an image is not permission to learn where
  # to push it.
  #
  # Both calls here are account-wide list operations that take no resource, so
  # AWS requires the wildcard; cd.yml filters the results by name. They leak
  # the names of buckets and distributions in this account and nothing else —
  # no contents, no configuration. `ecr:DescribeRepositories` does take a
  # resource, so it stays pinned to this project's repository above.
  statement {
    sid = "DiscoverInfrastructure"
    actions = [
      "s3:ListAllMyBuckets",
      "cloudfront:ListDistributions",
      # The migration step runs a one-off task on the same network as the
      # service, and finds that network by tag rather than being told it, so it
      # needs to read the VPC layout it is about to launch into. Both are
      # describe-only; nothing here can create, modify or delete networking.
      "ec2:DescribeSubnets",
      "ec2:DescribeSecurityGroups",
    ]
    resources = ["*"]
  }

  # Register a new task definition and roll the service.
  # Split in two, because these ECS calls disagree about whether they take a
  # resource. RegisterTaskDefinition and the Describe/List calls do not — AWS
  # requires "*" for them — while the calls that act on a running service do,
  # and are pinned to this project's cluster so a compromised workflow cannot
  # touch another one in the same account.
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

  # Hand the task roles to ECS. Restricted to the two roles this project owns,
  # so the workflow cannot start a task as an arbitrary, more privileged role.
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

  # Publish the SPA.
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

  # Read logs when a deploy fails, so CD can report why rather than just that.
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
# A second identity, because the deploy role above is deliberately scoped to
# `ref:refs/heads/main` and a pull request's token carries
# `pull_request` in its `sub` instead. That scoping is correct — it is what
# stops a fork's PR from reaching AWS — but it also means `terraform plan`
# cannot run on the PR that proposes the change, which is where a plan is
# actually useful.
#
# This role closes that gap without widening the deploy role: it is trusted for
# pull requests from THIS repository only, and it can read but never write.

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

    # `repo:owner/name:pull_request` is the sub GitHub mints for a pull request
    # workflow. A fork's PR carries its own repository in that claim, so this
    # matches only PRs raised from a branch of this repository.
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

# ReadOnlyAccess rather than an enumerated list: `terraform plan` refreshes
# every resource in the state, so it touches most of the services this project
# uses, and a hand-written list would fail opaquely each time the stack gains a
# resource type. The role cannot mutate anything, which is the property that
# matters.
resource "aws_iam_role_policy_attachment" "github_plan_readonly" {
  role       = aws_iam_role.github_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# The one permission ReadOnlyAccess deliberately withholds, and the one `plan`
# cannot do without: refreshing `aws_secretsmanager_secret_version` reads the
# value back. Scoped to this project's secrets, so the role can read the eight
# it is already responsible for planning and nothing else in the account.
#
# Worth being explicit about the trade: a workflow running with this role can
# read these production credentials. It is already trusted to plan against the
# account, it cannot write anything, and it is assumable only by pull requests
# from this repository — a fork's PR carries its own repository in the subject
# claim and is rejected. The alternative is `-refresh=false` on the plan, which
# would hide genuine drift and is a worse trade.
data "aws_iam_policy_document" "github_plan_secrets" {
  statement {
    sid       = "ReadProjectSecrets"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [for s in aws_secretsmanager_secret.app : s.arn]
  }
}

resource "aws_iam_role_policy" "github_plan_secrets" {
  name   = "read-project-secrets"
  role   = aws_iam_role.github_plan.id
  policy = data.aws_iam_policy_document.github_plan_secrets.json
}

# ReadOnlyAccess does not include reading secret *values*, and plan does not
# need them — but it does need to read the state file, which lives in S3 and is
# covered above. Locking is not configured (see backend.hcl), so no write to
# the bucket is required either.
