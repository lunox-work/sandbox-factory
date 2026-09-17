# Provider and version pinning.
#
# Two providers of the same type: `aws` runs in the region that hosts the
# application, and `aws.us_east_1` is fixed to N. Virginia because CloudFront
# reads its certificate from there and nowhere else. With var.region set to
# us-east-1 the two alias the same region, which is harmless — the split exists
# so that moving the application to another region stays a one-variable change.

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

  # Remote state is deliberately left to a backend config file rather than
  # hardcoded here, so a fork can `terraform init` without inheriting this
  # account's bucket. See infra/README.md for the bootstrap.
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
