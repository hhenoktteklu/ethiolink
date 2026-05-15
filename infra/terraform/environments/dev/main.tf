# EthioLink — dev environment
#
# Module wiring starts here. Resources should be declared via reusable modules
# under ../../modules/, not inline, unless there is an accompanying ADR.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Remote state backend declared in backend.tf (added in Phase 1).
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "ethiolink"
      Environment = "dev"
      ManagedBy   = "terraform"
    }
  }
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

# -----------------------------------------------------------------------------
# Phase 1 — Cognito
#
# Provisions the user pool, role groups, and app clients for the dev
# environment. Outputs feed directly into backend/.env after `terraform apply`.
# -----------------------------------------------------------------------------

module "cognito" {
  source = "../../modules/cognito"

  environment = "dev"

  # Admin dashboard runs on `npm run dev` (Vite) for local
  # development and against the CloudFront-fronted S3 distribution
  # once the Phase 7 admin-frontend module lands. Both URLs will
  # need to be registered on the Cognito admin client; the
  # CloudFront URL is appended to this list alongside the
  # admin-frontend module commit. For now only the Vite dev URL
  # is listed. `/login` matches the SPA route at
  # `admin/src/pages/LoginPage.tsx` that handles the `?code=...`
  # exchange.
  admin_callback_urls = ["http://localhost:5173/login"]
  admin_logout_urls   = ["http://localhost:5173/login"]
}

output "cognito_user_pool_id" {
  description = "Cognito user pool id for the dev environment."
  value       = module.cognito.user_pool_id
}

output "cognito_user_pool_arn" {
  description = "Cognito user pool ARN for the dev environment."
  value       = module.cognito.user_pool_arn
}

output "cognito_mobile_app_client_id" {
  description = "Cognito app client id for the Flutter mobile app."
  value       = module.cognito.mobile_app_client_id
}

output "cognito_admin_app_client_id" {
  description = "Cognito app client id for the React admin dashboard."
  value       = module.cognito.admin_app_client_id
}

output "cognito_hosted_ui_domain" {
  description = "Cognito hosted-UI domain prefix for the dev environment."
  value       = module.cognito.hosted_ui_domain
}

# Phase 2/7 will add:
#   module "s3"          { source = "../../modules/s3"          ... }
#   module "rds"         { source = "../../modules/rds"         ... }
#   module "api_gateway" { source = "../../modules/api-gateway" ... }
#   module "lambda"      { source = "../../modules/lambda"      ... }
#   module "cloudwatch"  { source = "../../modules/cloudwatch"  ... }
