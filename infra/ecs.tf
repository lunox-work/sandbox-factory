# ECS Fargate service running the API.
#
# ARM64, because Graviton is roughly 20% cheaper than x86 for identical work and
# node:22-alpine is multi-arch — so this costs nothing to adopt. The CD workflow
# must build with --platform linux/arm64 to match; a mismatch fails at task
# start with "exec format error", which is the one failure mode worth
# remembering here.

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled" # ~$2/month per task once enabled; off until it is needed.
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}-api"
  retention_in_days = var.log_retention_days
}

# The image tag is passed in by CD rather than hardcoded. On the very first
# apply no image exists yet, so this defaults to a placeholder and the service
# is created with desired_count honouring var.api_desired_count; see the
# bootstrap note in infra/README.md for the ordering.
variable "api_image_tag" {
  description = "ECR image tag to run. CD sets this to the commit SHA."
  type        = string
  default     = "bootstrap"
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_cpu
  memory                   = var.api_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  container_definitions = jsonencode([{
    name      = "api"
    image     = "${aws_ecr_repository.api.repository_url}:${var.api_image_tag}"
    essential = true

    portMappings = [{
      containerPort = var.api_port
      protocol      = "tcp"
    }]

    # Non-secret configuration, inline. Every value here is public knowledge:
    # the hostname is in DNS and the port is behind a security group.
    #
    # AUTH_COOKIE_DOMAIN is deliberately absent. The SPA and the API share one
    # origin through CloudFront, so the session cookie stays host-only — which
    # .env.example recommends, and which is strictly safer than scoping a
    # cookie to .lunox.work where other subdomains could read it.
    environment = [
      { name = "PORT", value = tostring(var.api_port) },
      { name = "NODE_ENV", value = "production" },
      { name = "BETTER_AUTH_URL", value = local.api_origin },
      { name = "APP_URL", value = local.api_origin },
      { name = "CORS_ORIGINS", value = local.api_origin },
      { name = "BUILD_SHA", value = var.api_image_tag },
      # Checked by the middleware in apps/api/src/routes.ts. Not a secret worth
      # a Secrets Manager entry: it is already visible in the CloudFront
      # distribution's origin config, and its only job is to distinguish CDN
      # traffic from a stranger who resolved the origin record.
      { name = "ORIGIN_VERIFY", value = random_password.origin_verify.result },
    ]

    # Resolved by the ECS agent before the container starts, so the values never
    # appear in the task definition, the console, or `describe-tasks` output.
    # DATABASE_URL is in this map now too: with Neon the connection string is a
    # credential pushed like any other, not something Terraform assembles.
    secrets = [for k, s in aws_secretsmanager_secret.app : {
      name      = k
      valueFrom = s.arn
    }]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = "api"
      }
    }

    # Defence in depth against a container that finds itself writing to disk.
    readonlyRootFilesystem = false

    # Without a load balancer, nothing else asks the API whether it can serve —
    # ECS would otherwise call a deployment stable because the process is alive,
    # stop the old task, and leave a running-but-broken one in production. This
    # is the check the ALB's target group used to perform.
    #
    # node rather than curl or wget: the runtime image is node:22-alpine, which
    # ships neither. A non-2xx status exits non-zero, so a process that is up
    # but failing its own health route is reported unhealthy.
    healthCheck = {
      command = [
        "CMD-SHELL",
        "node -e \"fetch('http://127.0.0.1:${var.api_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"",
      ]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${local.name}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets = aws_subnet.public[*].id
    # Required in a public subnet with no NAT: without it the task cannot reach
    # ECR to pull its own image, and fails before it starts.
    assign_public_ip = true
    security_groups  = [aws_security_group.tasks.id]
  }

  # No load_balancer and no service_registries. Service Discovery cannot
  # publish a public IP for an awsvpc task, so the origin record is maintained
  # by the function in discovery.tf instead, driven by task state changes.

  # 100/200: a new task starts and registers before the old one is removed.
  # With one task that means two run briefly during a deploy, and for a few
  # seconds the discovery record holds both IPs — CloudFront may reach either,
  # which is fine because both serve the same API.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # health_check_grace_period_seconds is not set: it applies only to load
  # balancer health checks, and there is no load balancer. ECS falls back to the
  # container's own health, which is whether the process is running.

  # Rolls a deploy forward without Terraform: CD updates the service directly,
  # and the next plan should not try to undo it.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
