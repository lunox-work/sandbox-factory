# Input variables.
#
# Every default here is the launch configuration described in the hosting plan.
# Nothing in this file is a secret: secret *values* are never Terraform inputs,
# only the empty containers that hold them. See secrets.tf.

variable "project" {
  description = "Name prefix for every resource. Also the Docker image name."
  type        = string
  default     = "sandbox-factory"
}

variable "region" {
  description = "Region hosting the API, database and load balancer."
  type        = string
  default     = "us-east-1"
}

variable "domain_name" {
  description = "Public hostname the platform is served on."
  type        = string
  default     = "platform.lunox.work"
}

variable "hosted_zone_id" {
  description = "Route53 zone for lunox.work. Records are added, never replaced — the zone also carries live Zoho mail records."
  type        = string
  default     = "Z0322350XBJA735ZYCUY"
}

# ---- networking ------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR for the VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "az_count" {
  description = "How many AZs to spread subnets across. Two is the ALB minimum."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2
    error_message = "An Application Load Balancer requires subnets in at least two availability zones."
  }
}

# ---- api compute -----------------------------------------------------------

variable "api_cpu" {
  description = "Fargate CPU units for the API task. 256 = 0.25 vCPU."
  type        = number
  default     = 256
}

variable "api_memory" {
  description = "Fargate memory (MiB) for the API task."
  type        = number
  default     = 512
}

variable "api_desired_count" {
  description = "How many API tasks to run. One is the launch configuration; raise for redundancy."
  type        = number
  default     = 1
}

variable "api_port" {
  description = "Port the Hono server binds. Must match PORT in the task environment."
  type        = number
  default     = 4000
}

# ---- ci/cd -----------------------------------------------------------------

variable "github_repository" {
  description = "owner/repo allowed to assume the deploy role through OIDC."
  type        = string
  default     = "lunox-work/sandbox-factory"
}

variable "github_deploy_environment" {
  description = "GitHub Environment the deploy job runs in. A job that declares one gets `:environment:<name>` in its OIDC sub instead of the branch ref, so the trust policy must accept it."
  type        = string
  default     = "production"
}

variable "github_deploy_branch" {
  description = "The only branch permitted to deploy. Scopes the OIDC trust policy."
  type        = string
  default     = "main"
}

# ---- observability ---------------------------------------------------------

variable "log_retention_days" {
  description = "CloudWatch log retention. Unlimited retention bills forever for logs nobody reads."
  type        = number
  default     = 30
}

variable "alarm_email" {
  description = "Address for alarm notifications. Empty disables the SNS topic subscription."
  type        = string
  default     = ""
}
