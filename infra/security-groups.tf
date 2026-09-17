# Security groups. One, on the tasks.
#
# The task accepts inbound traffic from anywhere on its port, deliberately.
# What protects the origin is the X-Origin-Verify header CloudFront injects,
# checked by the API, plus the API's own auth. Postgres is Neon, outside AWS,
# so there is no database group.

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "API tasks. Reached by CloudFront over HTTP on the API port."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-tasks" }

  lifecycle {
    create_before_destroy = true
  }
}

# The hardening step, if this ever carries more than a handful of users, is
# CloudFront's managed prefix list:
#
#   aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
#
# Left open because that list changes, and a task made unreachable by an
# AWS-side update is a worse failure at this scale than an origin that answers
# 403 to strangers.
resource "aws_vpc_security_group_ingress_rule" "tasks_http" {
  security_group_id = aws_security_group.tasks.id
  description       = "API port. Requests without X-Origin-Verify are refused by the app."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = var.api_port
  to_port           = var.api_port
  ip_protocol       = "tcp"
}

# Unrestricted by necessity; the description lists what the task reaches.
resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  description       = "ECR, Secrets Manager, CloudWatch, Neon, OAuth providers"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
