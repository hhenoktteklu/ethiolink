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

  # Phase 9 Track 4 — flip the bucket SSE to SSE-KMS. New writes
  # encrypt under the CMK immediately; existing objects keep
  # their previous encryption until the re-encryption runbook
  # runs.
  media_kms_key_arn = module.kms.s3_media_key_arn
  logs_kms_key_arn  = module.kms.s3_logs_key_arn
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

  # Phase 9 Track 4 — wire the CMKs. RDS records the intended key
  # on the existing instance (in-place re-encryption is not
  # supported; the runbook covers the snapshot+restore path);
  # Secrets Manager re-encrypts the master secret on the next
  # version write.
  kms_key_id         = module.kms.rds_key_arn
  secrets_kms_key_id = module.kms.secrets_key_arn
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

  # Phase 9 Track 4 — wire the CMKs. `env_kms_key_arn` re-encrypts
  # every Lambda's env-var blob under the customer-managed key
  # on the next apply; `secrets_kms_key_arn` and
  # `s3_media_kms_key_arn` add the matching `kms:Decrypt` (and
  # for media, `kms:GenerateDataKey*`) grants to the per-domain
  # roles so cold-start secret resolution + media S3 reads /
  # writes keep working after the CMK flip.
  env_kms_key_arn      = module.kms.lambda_env_key_arn
  secrets_kms_key_arn  = module.kms.secrets_key_arn
  s3_media_kms_key_arn = module.kms.s3_media_key_arn

  # The migration runner targets the direct RDS endpoint. In dev
  # this is the same value as `effective_endpoint` (no proxy), but
  # we set it explicitly so the prod / dev wiring stays
  # parallel and the next operator searching for "where does the
  # migrator connect" finds the answer here, not in their head.
  function_env_overrides = {
    "maintenance-db-migrate" = {
      PG_HOST = module.rds.db_endpoint
    }
  }
}

output "lambda_db_migrate_function_name" {
  description = "Name of the migration-runner Lambda. Operators invoke it via `aws lambda invoke --function-name <name> /tmp/response.json` after every apply that ships a new migration."
  value       = module.lambda.db_migrate_function_name
}

output "lambda_execution_role_arns" {
  description = "Per-domain Lambda execution-role ARNs (Phase 8 refactor — was a single shared role)."
  value       = module.lambda.execution_role_arns
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

# -----------------------------------------------------------------------------
# Phase 7 — EventBridge
#
# 15-minute scheduled rule firing the `scheduled-send-reminders`
# Lambda. Enabled in dev so the reminder lifecycle can be smoke-
# tested against the real DB once migrations land.
# -----------------------------------------------------------------------------

module "eventbridge" {
  source = "../../modules/eventbridge"

  environment = "dev"

  scheduled_reminders_function_name = module.lambda.scheduled_reminders_function_name
  scheduled_reminders_function_arn  = module.lambda.scheduled_reminders_function_arn

  enabled = true
}

output "eventbridge_rule_arn" {
  description = "ARN of the 15-minute scheduled-reminder rule. Consumed by the future CloudWatch alarms module."
  value       = module.eventbridge.rule_arn
}

# -----------------------------------------------------------------------------
# Phase 7 — admin frontend
#
# Private S3 bucket fronted by CloudFront with OAC. Dev uses the
# CloudFront-assigned `<id>.cloudfront.net` domain — no custom
# alias, no ACM cert work needed for dev.
#
# Pre-build step:
#     cd admin
#     # Set VITE_COGNITO_DOMAIN, VITE_COGNITO_ADMIN_CLIENT_ID,
#     # VITE_ADMIN_REDIRECT_URI, VITE_API_BASE_URL — see admin/README.md.
#     npm ci && npm run build
# -----------------------------------------------------------------------------

module "admin_frontend" {
  source = "../../modules/admin-frontend"

  environment     = "dev"
  admin_dist_path = abspath("${path.root}/../../../admin/dist")

  # No custom domain in dev — operators visit the CloudFront URL
  # directly. The Cognito callback list still needs to include
  # this URL, but registering the CloudFront-assigned domain
  # there is a Cognito follow-up the operator does after the
  # first apply (the domain is only known post-create).

  # Phase 8 — CSP origin allow-list. The SPA needs to `fetch` API
  # Gateway + Cognito and `<img>` the public-media bucket; without
  # these the browser's CSP enforcer blocks every authenticated
  # request and every business cover photo.
  api_gateway_origin  = module.api_gateway.invoke_url
  cognito_origin      = "https://${module.cognito.hosted_ui_domain}.auth.${var.region}.amazoncognito.com"
  media_public_origin = "https://${module.s3.media_public_bucket_name}.s3.${var.region}.amazonaws.com"

  # Phase 9 Track 4 — flip the bucket's SSE to SSE-KMS. CloudFront
  # OAC reads continue to work because the matching key policy
  # grants the CloudFront service principal `kms:Decrypt` in this
  # account (fenced by `aws:SourceAccount`).
  kms_key_arn = module.kms.s3_admin_frontend_key_arn
}

output "admin_frontend_url" {
  description = "URL operators visit to use the admin dashboard."
  value       = module.admin_frontend.admin_url
}

output "admin_frontend_bucket" {
  description = "Private S3 bucket name."
  value       = module.admin_frontend.bucket_name
}

output "admin_frontend_distribution_id" {
  description = "CloudFront distribution id — pass to `aws cloudfront create-invalidation` after a deploy."
  value       = module.admin_frontend.cloudfront_distribution_id
}

# -----------------------------------------------------------------------------
# Phase 7 — WAF
#
# Regional WAFv2 Web ACL on the API Gateway stage. Stage ARN is
# computed inline from the API Gateway outputs — the API Gateway
# module exposes `rest_api_id` + `stage_name`, which together
# form the standard `arn:aws:apigateway:<region>::/restapis/.../stages/...`
# shape that `aws_wafv2_web_acl_association.resource_arn` expects.
# -----------------------------------------------------------------------------

module "waf" {
  source = "../../modules/waf"

  environment = "dev"

  api_gateway_stage_arn = "arn:aws:apigateway:${var.region}::/restapis/${module.api_gateway.rest_api_id}/stages/${module.api_gateway.stage_name}"

  # 2000 req / 5 min / IP — the AWS-managed-rule defaults are
  # plenty conservative for dev. Tune in prod once the first
  # load test surfaces real per-IP rates.
  rate_limit_per_5min = 2000
}

output "waf_web_acl_arn" {
  description = "WAFv2 Web ACL ARN. The CloudWatch alarm module references this."
  value       = module.waf.web_acl_arn
}

# -----------------------------------------------------------------------------
# Phase 7 — CloudWatch dashboards + alarms
#
# SNS topic + 7 alarms + 4 dashboards. `alarm_email` left empty
# by default — the operator fills it in via `terraform.tfvars`
# (or a CI-side secret) once a real address is finalized. The
# SNS subscription confirmation link must be clicked manually.
# -----------------------------------------------------------------------------

variable "alarm_email" {
  description = "Operator email for the alarms SNS topic. Empty to skip the subscription. The address must confirm the AWS subscription email after the first apply."
  type        = string
  default     = ""
}

module "cloudwatch" {
  source = "../../modules/cloudwatch"

  environment = "dev"
  region      = var.region

  alarm_email = var.alarm_email

  rest_api_id            = module.api_gateway.rest_api_id
  api_gateway_stage_name = module.api_gateway.stage_name

  lambda_function_names = module.lambda.function_names

  rds_instance_identifier = module.rds.db_instance_identifier

  eventbridge_rule_name = module.eventbridge.rule_name

  waf_web_acl_name = module.waf.web_acl_name
}

output "cloudwatch_alarm_sns_topic_arn" {
  description = "ARN of the alarm SNS topic. Future migration-runner / smoke-test workflows attach here for their own alarms."
  value       = module.cloudwatch.alarm_sns_topic_arn
}

output "cloudwatch_dashboard_names" {
  description = "Map of dashboard key → dashboard name. Open via `aws cloudwatch get-dashboard --dashboard-name <name>` or the AWS console."
  value       = module.cloudwatch.dashboard_names
}

# -----------------------------------------------------------------------------
# Phase 8 — Secrets rotation
#
# AWS-managed RDS password rotation via SAR. Dev keeps the
# default 30-day cadence; first rotation fires immediately after
# the module is applied (validates the rotation Lambda actually
# works before the steady-state window).
# -----------------------------------------------------------------------------

module "secrets_rotation" {
  source = "../../modules/secrets"

  environment = "dev"
  region      = var.region

  rds_master_secret_arn    = module.rds.master_secret_arn
  private_subnet_ids       = module.vpc.private_subnet_ids
  lambda_security_group_id = module.vpc.lambda_security_group_id

  rotation_days = 30
  enabled       = true

  # Phase 9 Track 4 — when the RDS master secret flips to the
  # customer-managed CMK, the SAR rotation Lambda's execution
  # role needs `kms:Decrypt` on that key to read the current
  # value during rotation. Passing the key ARN here triggers the
  # module to attach the inline policy.
  secrets_kms_key_arn = module.kms.secrets_key_arn
}

output "secrets_rotation_enabled" {
  description = "Whether RDS password rotation is provisioned. Mirrors the module input — exposed for the smoke-test workflow to verify post-apply."
  value       = module.secrets_rotation.rotation_enabled
}

output "secrets_rotation_lambda_name" {
  description = "Name of the SAR-deployed rotation Lambda. Useful for `aws logs tail` during incident response."
  value       = module.secrets_rotation.rotation_lambda_name
}

# -----------------------------------------------------------------------------
# Phase 9 Track 4 — KMS
#
# Per-service customer-managed keys (`rds`, `s3_media`, `s3_logs`,
# `s3_admin_frontend`, `secrets`, `lambda_env`). This commit lands
# the keys ONLY — the consumer modules (rds, s3, secrets, lambda)
# keep their AWS-managed encryption until the follow-up commit
# threads the new ARNs through their `kms_key_*` inputs and the
# operator runs the re-encryption runbook.
#
# Dev uses the AWS-minimum 7-day deletion window so a throwaway
# stack can tear down quickly. Prod keeps the 30-day default.
# -----------------------------------------------------------------------------

module "kms" {
  source = "../../modules/kms"

  environment             = "dev"
  deletion_window_in_days = 7
}

output "kms_key_arns" {
  description = "Map of service slug → CMK ARN for the dev env. Stands by unused until the consumer-wiring commit; surface here so the operator can review the plan before any data moves."
  value       = module.kms.key_arns
}

output "kms_alias_names" {
  description = "Map of service slug → alias name (`alias/ethiolink-dev-<service>`). Convenient for `aws kms describe-key --key-id <alias>` smoke checks after apply."
  value       = module.kms.alias_names
}
