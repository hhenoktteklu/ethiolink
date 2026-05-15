# EthioLink — prod environment
#
# Cognito lands first per the Phase 7 module order; the remaining
# modules (VPC, RDS, S3, Lambda, API Gateway, EventBridge,
# CloudFront, WAF, CloudWatch) follow once the dev environment has
# applied each one cleanly. Every prod module must keep
# `prevent_destroy = true` on resources that hold user-visible
# state (Cognito user pool, RDS instance, S3 buckets).

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

# -----------------------------------------------------------------------------
# Phase 7 — Cognito
#
# Provisions the prod user pool, role groups, and app clients. The
# admin client is a public PKCE client (same shape as dev — see the
# module main.tf header for the rationale); the prod admin URL is
# the real domain at `https://admin.ethiolink.app/login`.
# -----------------------------------------------------------------------------

module "cognito" {
  source = "../../modules/cognito"

  environment = "prod"

  # Real production admin domain. The admin SPA is deployed to the
  # CloudFront distribution behind this hostname by the Phase 7
  # admin-frontend module. `/login` matches the SPA route
  # (`admin/src/pages/LoginPage.tsx`) that handles the `?code=...`
  # exchange.
  admin_callback_urls = ["https://admin.ethiolink.app/login"]
  admin_logout_urls   = ["https://admin.ethiolink.app/login"]

  # Mobile callbacks stay on the Flutter deep-link scheme — the
  # module default is correct for prod and dev alike, but pinning
  # the value here keeps the prod stack explicit about what's
  # registered.
  mobile_callback_urls = ["ethiolink://auth/callback"]
  mobile_logout_urls   = ["ethiolink://auth/logout"]
}

output "cognito_user_pool_id" {
  description = "Cognito user pool id for the prod environment."
  value       = module.cognito.user_pool_id
}

output "cognito_user_pool_arn" {
  description = "Cognito user pool ARN for the prod environment."
  value       = module.cognito.user_pool_arn
}

output "cognito_mobile_app_client_id" {
  description = "Cognito app client id for the Flutter mobile app (prod)."
  value       = module.cognito.mobile_app_client_id
}

output "cognito_admin_app_client_id" {
  description = "Cognito app client id for the React admin dashboard (prod)."
  value       = module.cognito.admin_app_client_id
}

output "cognito_hosted_ui_domain" {
  description = "Cognito hosted-UI domain prefix for the prod environment."
  value       = module.cognito.hosted_ui_domain
}

# Phase 7 will add (in roughly this order):
#   module "vpc"            { source = "../../modules/vpc"            ... }
#   module "s3"             { source = "../../modules/s3"             ... }
#   module "rds"            { source = "../../modules/rds"            ... }  # + RDS Proxy in prod
#   module "lambda"         { source = "../../modules/lambda"         ... }
#   module "api_gateway"    { source = "../../modules/api-gateway"    ... }
#   module "eventbridge"    { source = "../../modules/eventbridge"    ... }
#   module "admin_frontend" { source = "../../modules/admin-frontend" ... }
#   module "waf"            { source = "../../modules/waf"            ... }
#   module "cloudwatch"     { source = "../../modules/cloudwatch"     ... }
