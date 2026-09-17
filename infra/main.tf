# Shared locals and data sources.

data "aws_availability_zones" "available" {
  state = "available"

  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

data "aws_caller_identity" "current" {}

locals {
  name = var.project

  tags = {
    Project   = var.project
    ManagedBy = "terraform"
    Repo      = var.github_repository
  }

  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # One subnet per AZ out of the /16, each a /24: 10.20.0.0/24, 10.20.1.0/24.
  # There are no database subnets: Postgres is Neon, outside this VPC.
  public_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i)]

  api_origin = "https://${var.domain_name}"
}
