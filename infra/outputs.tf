# Outputs for the operator. No secret value or ARN: `make secrets-push` finds
# secrets by name.

output "url" {
  description = "The platform."
  value       = "https://${var.domain_name}"
}

output "aws_region" {
  description = "Region hosting the API and database."
  value       = var.region
}

output "ecr_repository_url" {
  description = "Push the API image here. CD reads this."
  value       = aws_ecr_repository.api.repository_url
}

output "ecs_cluster_name" {
  description = "ECS cluster name. CD reads this."
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "ECS service name. CD reads this."
  value       = aws_ecs_service.api.name
}

output "task_definition_family" {
  description = "Task definition family. CD registers new revisions against it."
  value       = aws_ecs_task_definition.api.family
}

output "web_bucket" {
  description = "S3 bucket holding the SPA. CD syncs apps/web/dist here."
  value       = aws_s3_bucket.web.id
}

output "cloudfront_distribution_id" {
  description = "Distribution to invalidate after publishing the SPA."
  value       = aws_cloudfront_distribution.main.id
}

output "cloudfront_domain" {
  description = "The distribution's own hostname, behind the alias."
  value       = aws_cloudfront_distribution.main.domain_name
}

output "github_deploy_role_arn" {
  description = "Set as the AWS_DEPLOY_ROLE repository variable in GitHub."
  value       = aws_iam_role.github_deploy.arn
}

output "origin_hostname" {
  description = "Where CloudFront reaches the API. The origin-dns function keeps this pointed at the running task's public IP."
  value       = local.origin_record
}

output "task_security_group_id" {
  description = "Security group for one-off tasks, such as migrations."
  value       = aws_security_group.tasks.id
}

output "public_subnet_ids" {
  description = "Subnets for one-off tasks, such as migrations."
  value       = aws_subnet.public[*].id
}

# Everything a deploy needs, in one blob. cd.yml does not read it: it looks
# the same values up in the live account (see DiscoverInfrastructure in
# oidc.tf).
output "cd_config" {
  description = "Consolidated configuration for the CD workflow."
  value = jsonencode({
    region         = var.region
    ecr_repository = aws_ecr_repository.api.repository_url
    cluster        = aws_ecs_cluster.main.name
    service        = aws_ecs_service.api.name
    family         = aws_ecs_task_definition.api.family
    bucket         = aws_s3_bucket.web.id
    distribution   = aws_cloudfront_distribution.main.id
    url            = "https://${var.domain_name}"
    subnets        = aws_subnet.public[*].id
    security_group = aws_security_group.tasks.id
  })
}

output "github_plan_role_arn" {
  description = "Set as the AWS_PLAN_ROLE repository variable. Read-only, for terraform plan on pull requests."
  value       = aws_iam_role.github_plan.arn
}
