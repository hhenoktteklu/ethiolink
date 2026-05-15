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

# -----------------------------------------------------------------------------
# Phase 7 — VPC
#
# Two-AZ topology with one NAT Gateway per AZ. Single-AZ NAT loss
# would otherwise strand Lambdas in the surviving AZ without egress
# — paired NATs are the prod posture per `AWS_DEPLOYMENT.md`.
# The bastion SG is created (no instance) so a real on-call need
# can land an EC2 bastion with no Terraform churn.
# -----------------------------------------------------------------------------

module "vpc" {
  source = "../../modules/vpc"

  environment = "prod"

  vpc_cidr          = "10.1.0.0/16"
  az_count          = 2
  nat_gateway_count = 2

  enable_bastion_sg = true
  # `bastion_allowed_cidrs` left empty by default — the operator
  # adds their own IP via an out-of-band SG ingress rule when
  # bastion access is actually needed, rather than hardcoding an
  # office IP into Terraform.
  bastion_allowed_cidrs = []
}

output "vpc_id" {
  description = "Prod VPC id."
  value       = module.vpc.vpc_id
}

output "vpc_private_subnet_ids" {
  description = "Private subnet ids. Lambdas + RDS live here."
  value       = module.vpc.private_subnet_ids
}

output "vpc_public_subnet_ids" {
  description = "Public subnet ids. NAT gateways + (future) bastion live here."
  value       = module.vpc.public_subnet_ids
}

output "vpc_lambda_security_group_id" {
  description = "Security group every EthioLink Lambda attaches to."
  value       = module.vpc.lambda_security_group_id
}

output "vpc_rds_security_group_id" {
  description = "Security group the RDS instance attaches to. Ingress from Lambda SG (and the bastion SG)."
  value       = module.vpc.rds_security_group_id
}

output "vpc_bastion_security_group_id" {
  description = "Security group the operator bastion attaches to."
  value       = module.vpc.bastion_security_group_id
}

# -----------------------------------------------------------------------------
# Phase 7 — S3 buckets
#
# Same shape as dev, with the prod admin origin pre-registered and
# longer log retention (365d). The mobile origin list stays empty
# — native apps don't enforce CORS.
# -----------------------------------------------------------------------------

module "s3" {
  source = "../../modules/s3"

  environment = "prod"

  # Real admin domain. The admin SPA fetches public media via
  # direct S3 URLs (or, eventually, via a CloudFront-fronted
  # alias) — either path emits an `Origin: https://admin.ethiolink.app`
  # header, which the bucket policy must whitelist.
  admin_allowed_origins = ["https://admin.ethiolink.app"]

  mobile_allowed_origins = []

  # 365-day log retention in prod — long enough to investigate
  # quarterly incidents; outside that window the cost of object
  # storage exceeds the value of preservation. Phase 8 may move
  # older logs to Glacier instead of expiring.
  logs_expiration_days = 365

  # No public-bucket versioning today; an explicit audit-replay
  # need would flip this to `true`.
}

output "s3_media_public_bucket" {
  description = "Public media bucket name."
  value       = module.s3.media_public_bucket_name
}

output "s3_media_private_bucket" {
  description = "Private media bucket name."
  value       = module.s3.media_private_bucket_name
}

output "s3_logs_bucket" {
  description = "Server-access-log target bucket name."
  value       = module.s3.logs_bucket_name
}

# Phase 7 will add (in roughly this order):
#   module "rds"            { source = "../../modules/rds"            ... }  # + RDS Proxy in prod
#   module "lambda"         { source = "../../modules/lambda"         ... }
#   module "api_gateway"    { source = "../../modules/api-gateway"    ... }
#   module "eventbridge"    { source = "../../modules/eventbridge"    ... }
#   module "admin_frontend" { source = "../../modules/admin-frontend" ... }
#   module "waf"            { source = "../../modules/waf"            ... }
#   module "cloudwatch"     { source = "../../modules/cloudwatch"     ... }
