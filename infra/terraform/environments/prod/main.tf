# EthioLink — prod environment
#
# Phase 0 stub. Resources are introduced in Phase 7 only, after dev has proved out.
# All prod modules must apply prevent_destroy where it matters (Cognito, RDS, S3).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state backend declared in backend.tf (added in Phase 7).
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "ethiolink"
      Environment = "prod"
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

# Phase 7 will introduce production modules. Until then this file is intentionally empty.
