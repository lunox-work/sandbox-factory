# Security groups.
#
# With the ALB gone there is one group left, on the tasks themselves, and it
# carries the whole burden of protecting the origin.
#
# The task accepts inbound traffic from anywhere on its port, and that is not a
# mistake: CloudFront publishes no stable IP range worth pinning, so a CIDR rule
# cannot express "only the CDN". What actually protects the origin is the
# X-Origin-Verify header that CloudFront injects and the API's own auth — the
# same shape the ALB listener rule enforced before, moved up a layer.
#
# The database is no longer here at all. Postgres is Neon, outside AWS, reached
# over TLS on the public internet, so there is no database security group and no
# private subnet to put one in.

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "API tasks. Reached by CloudFront over HTTP on the API port."
  vpc_id      = aws_vpc.main.id

  tags = { Name = "${local.name}-tasks" }

  lifecycle {
    create_before_destroy = true
  }
}

# Open on the API port, for the reason above. Narrowing this to CloudFront's
# published prefix list is possible and is the obvious hardening step if this
# ever carries more than a handful of users:
#
#   aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing
#
# It is left open here because that prefix list changes, and a task that becomes
# unreachable after an AWS-side update is a worse failure at this scale than an
# origin that answers 403 to strangers.
resource "aws_vpc_security_group_ingress_rule" "tasks_http" {
  security_group_id = aws_security_group.tasks.id
  description       = "API port. Requests without X-Origin-Verify are refused by the app."
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = var.api_port
  to_port           = var.api_port
  ip_protocol       = "tcp"
}

# Outbound is unrestricted and has to be: the task pulls its image from ECR,
# reads Secrets Manager, ships logs to CloudWatch, connects to Neon over TLS,
# and completes OAuth token exchanges against Google, GitHub and Atlassian.
resource "aws_vpc_security_group_egress_rule" "tasks_all" {
  security_group_id = aws_security_group.tasks.id
  description       = "ECR, Secrets Manager, CloudWatch, Neon, OAuth providers"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
