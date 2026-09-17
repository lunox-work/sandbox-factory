# A stable hostname for a task whose IP is not stable.
#
# CloudFront resolves its origin from the public internet, and a Fargate task's
# public IP changes on every start; Fargate has no Elastic IP. EventBridge
# reports each ECS task state change, and a small function writes the running
# task's public IP into a Route53 A record, for about $0.20/month.
#
# ECS Service Discovery cannot do this: with `awsvpc` networking it registers
# only the task's private IP, which CloudFront cannot reach (502 from a healthy
# task). A load balancer can, at ~$16/month.
#
# The record lives directly in the lunox.work zone; the IAM conditions below
# confine the function to it.

locals {
  origin_record = "api.${var.domain_name}"
}

# ---- the function ----------------------------------------------------------

data "archive_file" "origin_dns" {
  type        = "zip"
  source_file = "${path.module}/lambda/origin_dns.py"
  output_path = "${path.module}/.terraform/origin_dns.zip"
}

resource "aws_lambda_function" "origin_dns" {
  function_name = "${local.name}-origin-dns"
  description   = "Points ${local.origin_record} at the running ECS task's public IP."

  filename         = data.archive_file.origin_dns.output_path
  source_code_hash = data.archive_file.origin_dns.output_base64sha256
  handler          = "origin_dns.handler"
  runtime          = "python3.12"
  architectures    = ["arm64"]
  timeout          = 30
  role             = aws_iam_role.origin_dns.arn

  # No `reserved_concurrent_executions`: the account is under the new-account
  # Lambda limit of 10 concurrent executions, below which AWS refuses any
  # reservation. Ordering is enforced in the function instead, with an
  # event-time marker that makes the newest event win; see origin_dns.py.

  environment {
    variables = {
      HOSTED_ZONE_ID = var.hosted_zone_id
      RECORD_NAME    = local.origin_record
      CLUSTER        = aws_ecs_cluster.main.name
      TTL            = "15"
    }
  }
}

resource "aws_cloudwatch_log_group" "origin_dns" {
  name              = "/aws/lambda/${local.name}-origin-dns"
  retention_in_days = var.log_retention_days
}

# ---- permissions -----------------------------------------------------------

data "aws_iam_policy_document" "origin_dns_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "origin_dns" {
  name               = "${local.name}-origin-dns"
  assume_role_policy = data.aws_iam_policy_document.origin_dns_assume.json
}

data "aws_iam_policy_document" "origin_dns" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.origin_dns.arn}:*"]
  }

  # Read-only. None of these calls accepts a resource ARN, so AWS requires
  # the wildcard.
  statement {
    sid       = "ReadTasks"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks", "ec2:DescribeNetworkInterfaces"]
    resources = ["*"]
  }

  # Lets the function read the record and its marker before writing.
  # ListResourceRecordSets has no per-record condition keys, so this can read
  # the whole zone; it cannot change any of it.
  statement {
    sid       = "ReadZone"
    actions   = ["route53:ListResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${var.hosted_zone_id}"]
  }

  # Scoped to the one zone, and constrained further by the conditions below.
  statement {
    sid       = "WriteOriginRecord"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${var.hosted_zone_id}"]

    # The zone also carries live Zoho MX and DKIM records. These conditions
    # stop a bug in the function, or anyone holding its role, from touching
    # anything but the origin record and its marker.
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values = [
        local.origin_record,
        # The ordering marker, written in the same change batch as the A
        # record. See origin_dns.py.
        "_origin-dns-marker.${local.origin_record}",
      ]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsRecordTypes"
      values   = ["A", "TXT"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsActions"
      values   = ["UPSERT"]
    }
  }
}

resource "aws_iam_role_policy" "origin_dns" {
  name   = "update-origin-record"
  role   = aws_iam_role.origin_dns.id
  policy = data.aws_iam_policy_document.origin_dns.json
}

# ---- the trigger -----------------------------------------------------------

resource "aws_cloudwatch_event_rule" "task_state" {
  name        = "${local.name}-task-state"
  description = "ECS task state changes for the API service."

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.main.arn]
      # RUNNING publishes a new IP; STOPPED prompts a re-read that drops one
      # no longer serving.
      lastStatus = ["RUNNING", "STOPPED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "origin_dns" {
  rule      = aws_cloudwatch_event_rule.task_state.name
  target_id = "origin-dns"
  arn       = aws_lambda_function.origin_dns.arn

  # A burst of task events can throttle against the account's Lambda limit;
  # retries keep a throttled event from being the one that carried the new IP.
  retry_policy {
    maximum_retry_attempts       = 4
    maximum_event_age_in_seconds = 300
  }
}

resource "aws_lambda_permission" "events" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.origin_dns.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.task_state.arn
}

# ---- origin protection -----------------------------------------------------

# The shared secret CloudFront sends and the API checks. No load balancer means
# no listener rule, so the check is middleware in apps/api/src/routes.ts.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}
