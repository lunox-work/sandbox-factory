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

# The one that matters most: no running task means the site is down, whatever
# else is green. This replaces the ALB's HealthyHostCount, which no longer
# exists — ECS is the only thing that knows whether the API is up.
resource "aws_cloudwatch_metric_alarm" "no_running_tasks" {
  alarm_name          = "${local.name}-no-running-tasks"
  alarm_description   = "No API tasks running. The platform is down."
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
