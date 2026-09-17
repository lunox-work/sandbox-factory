# Provider and version pinning.
#
# `aws` runs in the application's region. `aws.us_east_1` is fixed because
# CloudFront's certificate and the CloudFront, Route53 and billing metrics live
# only there. Today both are us-east-1; the split keeps moving the application
# a one-variable change.

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Backend settings live in a config file so a fork can `terraform init`
  # without inheriting this account's bucket. See infra/README.md.
  #
  #   terraform init -backend-config=backend.hcl
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = local.tags
  }
}

provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = local.tags
  }
}
