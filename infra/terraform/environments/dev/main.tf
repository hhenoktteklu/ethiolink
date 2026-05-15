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

# -----------------------------------------------------------------------------
# Phase 7 — VPC
#
# Two-AZ topology with a single shared NAT Gateway. Dev tolerates a
# single-AZ NAT outage (it's dev — outages are dev-only). Prod
# spreads NAT across both AZs in `environments/prod/main.tf`.
# Subnet CIDRs are deterministic carve-outs of the /16; see the
# module header for the layout.
# -----------------------------------------------------------------------------

module "vpc" {
  source = "../../modules/vpc"

  environment = "dev"

  vpc_cidr          = "10.0.0.0/16"
  az_count          = 2
  nat_gateway_count = 1

  enable_bastion_sg = false
}

output "vpc_id" {
  description = "Dev VPC id. Consumed by every other Phase 7 module."
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
  description = "Security group every EthioLink Lambda should attach to."
  value       = module.vpc.lambda_security_group_id
}

output "vpc_rds_security_group_id" {
  description = "Security group the RDS instance attaches to. Ingress allowed only from the Lambda SG."
  value       = module.vpc.rds_security_group_id
}

# -----------------------------------------------------------------------------
# Phase 7 — S3 buckets
#
# Three buckets: public media (CORS for the Vite dev origin),
# private media (presigned uploads + downloads), and a logs target
# for server access logging on the two media buckets. Versioning
# stays off on the public bucket (assets are easily replaced) and
# on the logs bucket (logs are append-only); private bucket keeps
# versioning ON for accidental-delete recovery.
# -----------------------------------------------------------------------------

module "s3" {
  source = "../../modules/s3"

  environment = "dev"

  # Admin SPA dev origin. The CloudFront URL from the admin-frontend
  # module appends to this list in its own commit.
  admin_allowed_origins = ["http://localhost:5173"]

  # Mobile is native — no browser CORS surface in dev.
  mobile_allowed_origins = []

  # 90-day log retention in dev — short enough to keep the bill
  # tiny, long enough to debug a week-old issue.
  logs_expiration_days = 90
}

output "s3_media_public_bucket" {
  description = "Public media bucket name. Maps to the `S3_BUCKET_MEDIA_PUBLIC` Lambda env."
  value       = module.s3.media_public_bucket_name
}

output "s3_media_private_bucket" {
  description = "Private media bucket name. Maps to the `S3_BUCKET_MEDIA_PRIVATE` Lambda env."
  value       = module.s3.media_private_bucket_name
}

output "s3_logs_bucket" {
  description = "Server-access-log target bucket name."
  value       = module.s3.logs_bucket_name
}

# Phase 7 will add:
#   module "rds"            { source = "../../modules/rds"            ... }
#   module "lambda"         { source = "../../modules/lambda"         ... }
#   module "api_gateway"    { source = "../../modules/api-gateway"    ... }
#   module "eventbridge"    { source = "../../modules/eventbridge"    ... }
#   module "admin_frontend" { source = "../../modules/admin-frontend" ... }
#   module "waf"            { source = "../../modules/waf"            ... }
#   module "cloudwatch"     { source = "../../modules/cloudwatch"     ... }
