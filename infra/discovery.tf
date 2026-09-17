# A stable hostname for a task whose IP is not stable.
#
# The problem: CloudFront resolves its origin from the public internet, and a
# Fargate task's public IP is assigned at start and released at stop. There is
# no Elastic IP for Fargate.
#
# The obvious answer is ECS Service Discovery, and it does not work here —
# with `awsvpc` networking it registers the task's *private* IP, with no option
# to publish the public one. Correct for service-to-service traffic inside a
# VPC; useless to CloudFront, which would resolve 10.20.x.x and time out. That
# was tried first and produced a 502 from a perfectly healthy task.
#
# The AWS-sanctioned answer is a load balancer, which costs ~$16/month to give
# one task a stable name. This is the same idea for about $0.20: EventBridge
# reports every ECS task state change, and a small function writes the public
# IP of whatever is running into a Route53 A-record.
#
# The record lives in the lunox.work zone directly. An earlier revision used a
# separate delegated zone because ECS owns every record in a namespace it
# manages; this function writes exactly one record by name, so that isolation
# is no longer bought by an extra hosted zone at $0.50/month.

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

  # No reserved concurrency, and it is not needed. This account is still under
  # the new-account Lambda limit of 10 concurrent executions, below which AWS
  # refuses any reservation — so serialising through `reserved_concurrent_executions`
  # is not available here even though it is the obvious answer.
  #
  # Ordering is enforced in the function instead. Every write carries the ECS
  # event time it came from, in a TXT record written in the same atomic change
  # batch as the A record, and an invocation stands down when it finds a marker
  # from a newer event. That turns "last writer wins" — where an older
  # invocation finishing late could restore a stopped task's IP — into "newest
  # event wins", which is the property that matters.

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

  # Reading which tasks are running, and the ENI behind each. Neither call
  # accepts a resource ARN, so the wildcard is the API's shape rather than a
  # loose policy — the function can only read.
  statement {
    sid       = "ReadTasks"
    actions   = ["ecs:ListTasks", "ecs:DescribeTasks", "ec2:DescribeNetworkInterfaces"]
    resources = ["*"]
  }

  # Reading the zone, so the write can be skipped when the record already says
  # the right thing — see the conditional in origin_dns.py. ListResourceRecordSets
  # takes the zone as its resource and has no per-record condition keys, so this
  # can see every record in the zone. It cannot change any: the write below is
  # what carries the name, type and action constraints.
  statement {
    sid       = "ReadZone"
    actions   = ["route53:ListResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${var.hosted_zone_id}"]
  }

  # Scoped to the one zone, and the change call is further constrained below.
  statement {
    sid       = "WriteOriginRecord"
    actions   = ["route53:ChangeResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${var.hosted_zone_id}"]

    # The zone also carries live Zoho MX and DKIM records. This condition is
    # what stops a bug in the function — or anyone who reaches its role — from
    # touching anything but the origin record.
    condition {
      test     = "ForAllValues:StringEquals"
      variable = "route53:ChangeResourceRecordSetsNormalizedRecordNames"
      values = [
        local.origin_record,
        # The ordering marker, written in the same change batch as the A record
        # so the two cannot disagree. See origin_dns.py.
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
      # Both transitions matter: RUNNING publishes a new IP, STOPPED prompts a
      # re-read that drops an IP which is no longer serving.
      lastStatus = ["RUNNING", "STOPPED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "origin_dns" {
  rule      = aws_cloudwatch_event_rule.task_state.name
  target_id = "origin-dns"
  arn       = aws_lambda_function.origin_dns.arn

  # A burst of task events can still throttle against the account's Lambda
  # limit. Retrying is what stops a throttled event from being the one that
  # would have published the new IP.
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

# The shared secret CloudFront sends and the API checks. With no load balancer
# there is no listener rule to enforce it, so the check lives in the
# application — see the middleware in apps/api/src/routes.ts.
resource "random_password" "origin_verify" {
  length  = 48
  special = false
}
