# Alarms. Few on purpose: each matches a way this deployment fails, and a noisy
# channel gets ignored.
#
# With var.alarm_email empty the topic has no subscriber; alarms then show in
# the console without sending mail.

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email == "" ? 0 : 1

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# Dormant while Container Insights is off: the metric never reports, so this
# sits at OK whatever is happening. Do not read it as the platform being up;
# platform-down below is what detects an outage. Kept because, once armed, it
# names the cause (no task running) rather than the symptom.
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
  # Missing data is the normal state with Container Insights off. Enable
  # containerInsights in ecs.tf to arm this alarm.
  treat_missing_data = "notBreaching"

  dimensions = {
    ClusterName = aws_ecs_cluster.main.name
    ServiceName = aws_ecs_service.api.name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

# CloudFront sees every request, so this catches an unreachable origin as well
# as an erroring one.
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

# A billing surprise is the most likely failure here. The metric lives in
# us-east-1 regardless of where anything runs.
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
# A Route53 health check probes from outside, so it covers DNS, CloudFront, the
# certificate and origin routing as well as the task. That is why this exists
# rather than switching Container Insights on.
#
# GET /health is unauthenticated (routes.ts exempts it from origin
# verification) and its CloudFront behaviour is uncached, so the probe reads
# live state.
resource "aws_route53_health_check" "platform" {
  type              = "HTTPS"
  fqdn              = var.domain_name
  port              = 443
  resource_path     = "/health"
  request_interval  = 30
  failure_threshold = 3

  # CloudFront needs SNI to serve the right certificate.
  enable_sni = true

  tags = merge(local.tags, {
    Name = "${local.name}-platform"
  })
}

# Health check metrics publish to us-east-1 only, hence the aliased provider.
#
# Missing data is "breaching" here, unlike the other alarms: this probe runs
# every 30 seconds forever, so silence means the monitoring itself has stopped.
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
