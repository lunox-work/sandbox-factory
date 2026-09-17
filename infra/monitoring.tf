# Alarms.
#
# Three, chosen because each corresponds to a way this specific deployment
# fails. CloudWatch bills $0.10 per alarm per month; the real cost of a noisy
# alarm is that it trains you to ignore the channel, which is why there are
# three and not twenty.
#
# The ALB and RDS alarms an earlier revision carried are gone with those
# services. What replaces the ALB's HealthyHostCount is the running-task count
# below: with no load balancer, "is anything serving?" is a question about ECS
# rather than about a target group.
#
# With var.alarm_email empty the topic is still created but has no subscriber;
# alarms then show in the console without sending mail.

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Dormant unless Container Insights is switched on, and kept for the day it is:
# it names the *cause* (no task is running) where the Route53 check at the
# bottom of this file only sees the symptom (the site stopped answering). Until
# then the probe is what detects an outage — do not read this one being OK as
# the platform being up, because it reports OK either way.
resource "aws_cloudwatch_metric_alarm" "no_running_tasks" {
  alarm_name          = "${local.name}-no-running-tasks"
  alarm_description   = "No API tasks running. Requires Container Insights; see platform-down for the alarm that always reports."
  namespace           = "ECS/ContainerInsights"
  metric_name         = "RunningTaskCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  # Container Insights is disabled to save ~$2/month, so this metric only
  # reports when it is switched on. Missing data is therefore treated as fine
  # rather than as an outage — turn on containerInsights in ecs.tf to arm it.
  treat_missing_data = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.api.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# CloudFront sees every request, including the ones that never reach a task, so
# this catches an origin that is unreachable as well as one that is erroring.
resource "aws_cloudwatch_metric_alarm" "cdn_5xx" {
  provider = aws.us_east_1

  alarm_name          = "${local.name}-origin-errors"
  alarm_description   = "CloudFront is seeing 5xx responses from the API origin."
  namespace           = "AWS/CloudFront"
  metric_name         = "5xxErrorRate"
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 2
  threshold           = 5 # percent
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    DistributionId = aws_cloudfront_distribution.main.id
    Region         = "Global"
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

# A billing surprise is the failure mode most likely to actually happen here.
# The metric lives in us-east-1 regardless of where anything runs.
resource "aws_cloudwatch_metric_alarm" "billing" {
  provider = aws.us_east_1

  alarm_name          = "${local.name}-monthly-spend"
  alarm_description   = "Estimated monthly charges above the expected ~$15 launch bill."
  namespace           = "AWS/Billing"
  metric_name         = "EstimatedCharges"
  statistic           = "Maximum"
  period              = 21600 # 6h — the metric only updates a few times a day.
  evaluation_periods  = 1
  threshold           = var.billing_alarm_threshold
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    Currency = "USD"
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

variable "billing_alarm_threshold" {
  description = "USD of estimated monthly charges that triggers an alarm. Account-wide, not project-only — your existing domain renewals count toward it."
  type        = number
  default     = 60
}

# ---- external uptime probe -------------------------------------------------
#
# The no-running-tasks alarm above cannot answer "is the site up?" — Container
# Insights is off, so its metric never reports and missing data is treated as
# not breaching. It sits permanently OK whatever is happening. This is what
# actually answers that question.
#
# A Route53 health check probes from outside AWS, so unlike an ECS metric it
# also catches a failure in DNS, CloudFront, the certificate, or the origin
# routing — every hop between a user and the task, not just the task. That is
# the better coverage, and it is why this rather than switching Insights on.
#
# It probes GET /health, which is safe to hit unauthenticated from anywhere:
# routes.ts exempts that path from origin verification precisely so probes
# reaching past the CDN keep working, and the CloudFront behaviour for it uses
# the managed CachingDisabled policy — so the probe reads live state rather
# than a cached "ok" from before the outage.
resource "aws_route53_health_check" "platform" {
  type              = "HTTPS"
  fqdn              = var.domain_name
  port              = 443
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3

  # SNI, required for CloudFront to serve the right certificate.
  enable_sni = true

  tags = merge(local.tags, {
    Name = "${local.name}-platform"
  })
}

# Health checks publish to us-east-1 regardless of where anything runs, which
# is why this alarm takes the aliased provider like the CloudFront one above.
#
# `treat_missing_data` is "breaching" here, unlike every other alarm in this
# file. Those guard metrics that legitimately go quiet; this one guards a
# probe that runs every 30 seconds forever. Silence from it is not "nothing to
# report", it is the monitoring itself having stopped — the exact condition
# that left the alarm above useless.
resource "aws_cloudwatch_metric_alarm" "platform_down" {
  provider = aws.us_east_1

  alarm_name          = "${local.name}-platform-down"
  alarm_description   = "platform.lunox.work is not answering /health. The platform is down."
  namespace           = "AWS/Route53"
  metric_name         = "HealthCheckStatus"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 2
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"

  dimensions = {
    HealthCheckId = aws_route53_health_check.platform.id
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}
