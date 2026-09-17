# ECS Fargate service running the API.
#
# ARM64: Graviton is roughly 20% cheaper than x86 and node:22-alpine is
# multi-arch. CD must build for linux/arm64 to match; a mismatch fails at task
# start with "exec format error".

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

# The default is a placeholder for the first apply, when no image exists yet;
# see the bootstrap note in infra/README.md for the ordering.
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

    # Non-secret configuration. AUTH_COOKIE_DOMAIN is deliberately absent: the
    # SPA and the API share one origin, so the session cookie stays host-only,
    # which is safer than scoping it to .lunox.work (see .env.example).
    environment = [
      { name = "PORT", value = tostring(var.api_port) },
      { name = "NODE_ENV", value = "production" },
      { name = "BETTER_AUTH_URL", value = local.api_origin },
      { name = "APP_URL", value = local.api_origin },
      { name = "CORS_ORIGINS", value = local.api_origin },
      # BUILD_SHA is deliberately absent, do not add it: CD sets the real sha
      # on every deploy, and a copy here would revert to "bootstrap" on any
      # apply that did not pass -var api_image_tag=<sha>.
      #
      # ORIGIN_VERIFY is checked by the middleware in apps/api/src/routes.ts.
      # Not worth a Secrets Manager entry: it is already visible in the
      # CloudFront distribution's origin config.
      { name = "ORIGIN_VERIFY", value = random_password.origin_verify.result },
    ]

    # Resolved by the ECS agent before the container starts, so the values never
    # appear in the task definition, the console, or `describe-tasks` output.
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

    readonlyRootFilesystem = false

    # With no load balancer, this is the only check that the API can serve.
    # Without it ECS calls a deployment stable once the process is alive, stops
    # the old task, and leaves a running-but-broken one in production.
    #
    # node rather than curl: node:22-alpine has no curl. A non-2xx status exits
    # non-zero.
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

  # No load_balancer or service_registries: the function in discovery.tf
  # maintains the origin record instead, and explains why.

  # 100/200: the new task starts before the old one stops. With one task, two
  # run briefly during a deploy and the origin record holds both IPs; either
  # serves.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # health_check_grace_period_seconds is not set: it applies only to load
  # balancer health checks. The container healthCheck's startPeriod covers boot.

  # CD updates the service directly; the next plan must not undo it.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}
