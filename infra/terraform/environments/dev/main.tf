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

# -----------------------------------------------------------------------------
# Phase 7 — RDS
#
# Single-AZ Postgres 15 on a burstable ARM instance — the dev
# default. No RDS Proxy in dev (Lambda concurrency is too low to
# justify the cost). Master password lives in Secrets Manager as
# `ethiolink/dev/rds/master`.
# -----------------------------------------------------------------------------

module "rds" {
  source = "../../modules/rds"

  environment = "dev"

  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  rds_security_group_id = module.vpc.rds_security_group_id

  instance_class        = "db.t4g.small"
  multi_az              = false
  allocated_storage     = 20
  max_allocated_storage = 100

  backup_retention_days = 7

  enable_rds_proxy = false
}

output "rds_endpoint" {
  description = "Direct DB endpoint. Maps to `PG_HOST` in the Lambda env (dev has no proxy)."
  value       = module.rds.effective_endpoint
}

output "rds_port" {
  description = "DB port. Maps to `PG_PORT`."
  value       = module.rds.db_port
}

output "rds_database_name" {
  description = "Initial database name. Maps to `PG_DATABASE`."
  value       = module.rds.db_name
}

output "rds_master_secret_arn" {
  description = "Master-credentials secret ARN. The Lambda cold-start shim fetches the password from this secret before `loadConfig` runs."
  value       = module.rds.master_secret_arn
}

# -----------------------------------------------------------------------------
# Phase 7 — Lambda
#
# Every EthioLink handler ships as a Lambda function from the
# shared `backend/dist/lambda.zip` artifact produced by
# `backend/scripts/package.sh`. Operators must run the script
# before `terraform apply` — the Terraform plan refuses to proceed
# when the zip is missing.
#
# Dev uses the direct RDS endpoint (no proxy), 30-day log
# retention, and the module-default memory / timeout for every
# function.
# -----------------------------------------------------------------------------

module "lambda" {
  source = "../../modules/lambda"

  environment = "dev"
  region      = var.region

  package_zip_path = abspath("${path.root}/../../../backend/dist/lambda.zip")

  # VPC config — every Lambda attaches to the private subnets.
  private_subnet_ids       = module.vpc.private_subnet_ids
  lambda_security_group_id = module.vpc.lambda_security_group_id

  # RDS env wiring.
  pg_host               = module.rds.effective_endpoint
  pg_port               = module.rds.db_port
  pg_database           = module.rds.db_name
  pg_user               = "ethiolink"
  rds_master_secret_arn = module.rds.master_secret_arn

  # Cognito env wiring.
  cognito_user_pool_id         = module.cognito.user_pool_id
  cognito_app_client_id_mobile = module.cognito.mobile_app_client_id
  cognito_app_client_id_admin  = module.cognito.admin_app_client_id

  # S3 env wiring.
  media_public_bucket      = module.s3.media_public_bucket_name
  media_private_bucket     = module.s3.media_private_bucket_name
  media_public_bucket_arn  = module.s3.media_public_bucket_arn
  media_private_bucket_arn = module.s3.media_private_bucket_arn

  # Application-policy defaults — match `backend/.env.example`.
  notifications_provider        = "mock"
  payments_provider_cash        = "cash"
  payments_provider_online      = "mock"
  booking_cancel_cutoff_minutes = 240
  booking_slot_step_minutes     = 15
  booking_buffer_minutes        = 5
  default_timezone              = "Africa/Addis_Ababa"

  log_retention_days = 30
  log_level          = "info"
  node_env           = "production"
}

output "lambda_execution_role_arn" {
  description = "Shared Lambda execution role ARN."
  value       = module.lambda.execution_role_arn
}

output "lambda_function_names" {
  description = "Map of logical id → function name. Useful for `aws lambda invoke` smoke tests."
  value       = module.lambda.function_names
}

output "lambda_scheduled_reminders_function_name" {
  description = "Convenience output: the `scheduled-send-reminders` function name. The EventBridge module wires this as its rule target."
  value       = module.lambda.scheduled_reminders_function_name
}

# -----------------------------------------------------------------------------
# Phase 7 — API Gateway
#
# REST API wiring every Lambda into an HTTP route. Dev uses the
# default `*.execute-api` URL — custom-domain wiring lands in a
# follow-up commit alongside the prod ACM cert work.
# -----------------------------------------------------------------------------

module "api_gateway" {
  source = "../../modules/api-gateway"

  environment = "dev"
  region      = var.region

  cognito_user_pool_arn = module.cognito.user_pool_arn

  lambda_function_arns        = module.lambda.function_arns
  lambda_function_invoke_arns = module.lambda.function_invoke_arns
  lambda_function_names       = module.lambda.function_names

  # Admin SPA's Vite dev origin. Add the CloudFront URL alongside
  # the admin-frontend module commit.
  cors_allowed_origins = ["http://localhost:5173"]
}

output "api_gateway_invoke_url" {
  description = "Base URL the admin SPA + mobile app target. Bake into the Vite bundle as `VITE_API_BASE_URL`."
  value       = module.api_gateway.invoke_url
}

output "api_gateway_rest_api_id" {
  description = "REST API id — useful for `aws apigateway` CLI smoke tests."
  value       = module.api_gateway.rest_api_id
}

# Phase 7 will add:
#   module "eventbridge"    { source = "../../modules/eventbridge"    ... }
#   module "admin_frontend" { source = "../../modules/admin-frontend" ... }
#   module "waf"            { source = "../../modules/waf"            ... }
#   module "cloudwatch"     { source = "../../modules/cloudwatch"     ... }
