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

  # Phase 9 Track 4 — flip the bucket SSE to SSE-KMS under the
  # customer-managed CMKs. Existing objects keep their previous
  # encryption until the re-encryption runbook runs in a
  # scheduled maintenance window.
  media_kms_key_arn = module.kms.s3_media_key_arn
  logs_kms_key_arn  = module.kms.s3_logs_key_arn
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

# -----------------------------------------------------------------------------
# Phase 7 — RDS
#
# Multi-AZ Postgres 15 on a steady-state ARM instance, fronted by
# an RDS Proxy. Backups retained for the AWS maximum (35 days).
# Lambdas in prod target the proxy endpoint so a fan-out burst
# doesn't exhaust the DB's connection pool. The migration runner
# is the only client that targets the direct instance endpoint —
# proxy prepared-statement caching interferes with DDL.
# -----------------------------------------------------------------------------

module "rds" {
  source = "../../modules/rds"

  environment = "prod"

  vpc_id                = module.vpc.vpc_id
  private_subnet_ids    = module.vpc.private_subnet_ids
  rds_security_group_id = module.vpc.rds_security_group_id

  instance_class        = "db.m6g.large"
  multi_az              = true
  allocated_storage     = 100
  max_allocated_storage = 1000

  backup_retention_days = 35

  enable_rds_proxy              = true
  rds_proxy_idle_client_timeout = 600

  # Phase 9 Track 4 — record the intended CMK. AWS does not
  # support in-place key swap on an existing instance; the
  # re-encryption runbook (snapshot copy + restore) is the
  # supported migration path. New automated snapshots taken
  # after the runbook completes encrypt under the CMK.
  kms_key_id         = module.kms.rds_key_arn
  secrets_kms_key_id = module.kms.secrets_key_arn
}

output "rds_endpoint" {
  description = "RDS Proxy endpoint — the value Lambda env reads for `PG_HOST` in prod. Migration runner targets `rds_direct_endpoint` instead to bypass the proxy's prepared-statement caching."
  value       = module.rds.effective_endpoint
}

output "rds_direct_endpoint" {
  description = "Direct DB instance endpoint, used by the migration runner (DDL must bypass the proxy)."
  value       = module.rds.db_endpoint
}

output "rds_port" {
  description = "DB port."
  value       = module.rds.db_port
}

output "rds_database_name" {
  description = "Initial database name."
  value       = module.rds.db_name
}

output "rds_master_secret_arn" {
  description = "Master-credentials secret ARN."
  value       = module.rds.master_secret_arn
}

output "rds_proxy_endpoint" {
  description = "RDS Proxy endpoint. Same value as `rds_endpoint` in prod, but exposed separately so deploy scripts can be unambiguous about which surface they're targeting."
  value       = module.rds.proxy_endpoint
}

# -----------------------------------------------------------------------------
# Phase 7 — Lambda
#
# Same shape as dev with three differences: prod points
# `PG_HOST` at the RDS Proxy endpoint (`effective_endpoint` is
# the proxy when `enable_rds_proxy = true`); log retention is
# 90 days; and the function memory / timeout will get per-function
# overrides once the first load test surfaces real numbers.
# -----------------------------------------------------------------------------

module "lambda" {
  source = "../../modules/lambda"

  environment = "prod"
  region      = var.region

  # Same relative-path discipline as the dev stack: `path.root` is
  # `infra/terraform/environments/prod/`, so four `../` climb to
  # repo root before descending into `backend/dist/lambda.zip`.
  # `abspath()` resolves at plan time per-host; we never burn an
  # operator-local absolute path into Terraform inputs.
  package_zip_path = abspath("${path.root}/../../../../backend/dist/lambda.zip")

  private_subnet_ids       = module.vpc.private_subnet_ids
  lambda_security_group_id = module.vpc.lambda_security_group_id

  pg_host               = module.rds.effective_endpoint
  pg_port               = module.rds.db_port
  pg_database           = module.rds.db_name
  pg_user               = "ethiolink"
  rds_master_secret_arn = module.rds.master_secret_arn

  cognito_user_pool_id         = module.cognito.user_pool_id
  cognito_app_client_id_mobile = module.cognito.mobile_app_client_id
  cognito_app_client_id_admin  = module.cognito.admin_app_client_id

  media_public_bucket      = module.s3.media_public_bucket_name
  media_private_bucket     = module.s3.media_private_bucket_name
  media_public_bucket_arn  = module.s3.media_public_bucket_arn
  media_private_bucket_arn = module.s3.media_private_bucket_arn

  notifications_provider        = "mock"
  payments_provider_cash        = "cash"
  payments_provider_online      = "mock"
  booking_cancel_cutoff_minutes = 240
  booking_slot_step_minutes     = 15
  booking_buffer_minutes        = 5
  default_timezone              = "Africa/Addis_Ababa"

  log_retention_days = 90
  log_level          = "info"
  node_env           = "production"

  # Phase 9 Track 4 — wire the CMKs. Same wiring as dev: Lambda
  # env-vars re-encrypt under the customer-managed key; per-domain
  # roles gain scoped `kms:Decrypt` on the secrets CMK and
  # `kms:Decrypt` + `kms:GenerateDataKey*` on the media-bucket
  # CMK (media role only). The `enable_*_kms_permissions` booleans
  # gate the policy attachments at plan time so the module never
  # derives `count` from a computed (plan-unknown) ARN.
  env_kms_key_arn                 = module.kms.lambda_env_key_arn
  secrets_kms_key_arn             = module.kms.secrets_key_arn
  enable_secrets_kms_permissions  = true
  s3_media_kms_key_arn            = module.kms.s3_media_key_arn
  enable_s3_media_kms_permissions = true

  # CRITICAL prod difference: the migration runner targets the
  # direct RDS endpoint instead of the proxy. RDS Proxy's
  # prepared-statement caching interferes with DDL (CREATE TABLE
  # / ALTER TABLE / CREATE INDEX) — a migration would apply
  # against the proxy but partially-fail when the proxy's cached
  # session state collides with the new schema. The direct
  # endpoint bypasses the proxy entirely; the runner takes ~10
  # seconds for the 13 MVP migrations, well within Lambda budget.
  function_env_overrides = {
    "maintenance-db-migrate" = {
      PG_HOST = module.rds.db_endpoint
    }
  }
}

output "lambda_db_migrate_function_name" {
  description = "Name of the migration-runner Lambda. Operators invoke it via `aws lambda invoke --function-name <name> /tmp/response.json` after every apply that ships a new migration. In prod the function points at the direct RDS endpoint, bypassing the proxy."
  value       = module.lambda.db_migrate_function_name
}

output "lambda_execution_role_arns" {
  description = "Per-domain Lambda execution-role ARNs (Phase 8 refactor — was a single shared role)."
  value       = module.lambda.execution_role_arns
}

output "lambda_function_names" {
  description = "Map of logical id → function name."
  value       = module.lambda.function_names
}

output "lambda_scheduled_reminders_function_name" {
  description = "Name of the `scheduled-send-reminders` function. Wired into the EventBridge rule once that module lands."
  value       = module.lambda.scheduled_reminders_function_name
}

# -----------------------------------------------------------------------------
# Phase 7 — API Gateway
#
# REST API. Prod CORS allows the real admin SPA origin
# (`https://admin.ethiolink.app`); custom-domain wiring
# (`api.ethiolink.app`) lands in a follow-up commit alongside
# the ACM cert + Route 53 record set.
# -----------------------------------------------------------------------------

module "api_gateway" {
  source = "../../modules/api-gateway"

  environment = "prod"
  region      = var.region

  cognito_user_pool_arn = module.cognito.user_pool_arn

  lambda_function_arns        = module.lambda.function_arns
  lambda_function_invoke_arns = module.lambda.function_invoke_arns
  lambda_function_names       = module.lambda.function_names

  cors_allowed_origins = ["https://admin.ethiolink.app"]
}

output "api_gateway_invoke_url" {
  description = "Base URL — the admin SPA's `VITE_API_BASE_URL` and the mobile app's API base."
  value       = module.api_gateway.invoke_url
}

output "api_gateway_rest_api_id" {
  description = "REST API id."
  value       = module.api_gateway.rest_api_id
}

# -----------------------------------------------------------------------------
# Phase 7 — EventBridge
#
# Same 15-minute schedule as dev. Same `enabled = true` posture —
# prod needs reminders firing from day one. The CloudWatch alarm
# on this rule's `FailedInvocations` metric lands alongside the
# `cloudwatch` module.
# -----------------------------------------------------------------------------

module "eventbridge" {
  source = "../../modules/eventbridge"

  environment = "prod"

  scheduled_reminders_function_name = module.lambda.scheduled_reminders_function_name
  scheduled_reminders_function_arn  = module.lambda.scheduled_reminders_function_arn

  enabled = true

  # Phase 9 Track 6 — paid featuring sweep rule. The sweep runs
  # regardless of whether public featuring is enabled in this env;
  # admin-comp'd ACTIVE rows still need to expire on schedule.
  featuring_sweep_function_name = module.lambda.featuring_sweep_function_name
  featuring_sweep_function_arn  = module.lambda.featuring_sweep_function_arn
  featuring_sweep_enabled       = true
}

output "eventbridge_rule_arn" {
  description = "ARN of the 15-minute scheduled-reminder rule."
  value       = module.eventbridge.rule_arn
}

# -----------------------------------------------------------------------------
# Phase 7 — admin frontend
#
# Same shape as dev with the real `admin.ethiolink.app` alias
# attached when a us-east-1 ACM cert is available. Operators pass
# the cert ARN via `terraform.tfvars`; until then this module
# applies with empty values and CloudFront falls back to the
# default certificate (operators access the dashboard via the
# CloudFront-assigned URL).
# -----------------------------------------------------------------------------

variable "admin_custom_domain" {
  description = "Admin SPA custom domain. Leave empty until the us-east-1 ACM cert is provisioned out-of-band; the module then attaches the alias on the next apply."
  type        = string
  default     = ""
}

variable "admin_acm_certificate_arn" {
  description = "ARN of a us-east-1 ACM certificate covering `admin_custom_domain`. CloudFront requires `us-east-1` regardless of the application's primary region — that's a hard AWS constraint."
  type        = string
  default     = ""
}

module "admin_frontend" {
  source = "../../modules/admin-frontend"

  environment     = "prod"
  admin_dist_path = abspath("${path.root}/../../../admin/dist")

  custom_domain       = var.admin_custom_domain
  acm_certificate_arn = var.admin_acm_certificate_arn

  # Prod ships from edges closer to Ethiopia. PriceClass_200 adds
  # the Cape Town + Mumbai edges that PriceClass_100 omits.
  price_class = "PriceClass_200"

  # Phase 8 — CSP origin allow-list. Same shape as dev; the prod
  # values resolve to the real production hostnames.
  api_gateway_origin  = module.api_gateway.invoke_url
  cognito_origin      = "https://${module.cognito.hosted_ui_domain}.auth.${var.region}.amazoncognito.com"
  media_public_origin = "https://${module.s3.media_public_bucket_name}.s3.${var.region}.amazonaws.com"

  # Phase 9 Track 4 — flip the bucket SSE to SSE-KMS. CloudFront
  # OAC reads continue to work; the `s3_admin_frontend` CMK
  # policy grants the CloudFront service principal `kms:Decrypt`
  # fenced by `aws:SourceAccount`.
  kms_key_arn = module.kms.s3_admin_frontend_key_arn
}

output "admin_frontend_url" {
  description = "URL operators visit to use the admin dashboard. Switches between the CloudFront-assigned domain and the custom alias depending on whether the ACM cert is wired."
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
# Regional WAFv2 Web ACL on the prod API Gateway stage. Same
# managed rule groups as dev; rate-limit threshold is the same
# 2000 req / 5 min / IP default but is variabled here so a real
# load-test result can lift it without a module change.
# -----------------------------------------------------------------------------

variable "waf_rate_limit_per_5min" {
  description = "Per-IP rate limit on the prod WAF Web ACL. Default 2000 req / 5 min — bump once the first load test surfaces real per-IP rates for the mobile + admin clients."
  type        = number
  default     = 2000
}

module "waf" {
  source = "../../modules/waf"

  environment = "prod"

  api_gateway_stage_arn = "arn:aws:apigateway:${var.region}::/restapis/${module.api_gateway.rest_api_id}/stages/${module.api_gateway.stage_name}"

  rate_limit_per_5min = var.waf_rate_limit_per_5min
}

output "waf_web_acl_arn" {
  description = "WAFv2 Web ACL ARN."
  value       = module.waf.web_acl_arn
}

# -----------------------------------------------------------------------------
# Phase 7 — CloudWatch dashboards + alarms
#
# Same shape as dev. Prod's `alarm_email` should always be set
# (alerts@ethiolink.app or equivalent shared inbox). Thresholds
# stay at module defaults until the first prod load test surfaces
# real numbers.
# -----------------------------------------------------------------------------

variable "alarm_email" {
  description = "Operator email for the prod alarms SNS topic. Should be set before the first apply; the subscription confirmation link must be clicked manually."
  type        = string
  default     = ""
}

module "cloudwatch" {
  source = "../../modules/cloudwatch"

  environment = "prod"
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
  description = "ARN of the alarm SNS topic."
  value       = module.cloudwatch.alarm_sns_topic_arn
}

output "cloudwatch_dashboard_names" {
  description = "Map of dashboard key → dashboard name."
  value       = module.cloudwatch.dashboard_names
}

# -----------------------------------------------------------------------------
# Phase 8 — Secrets rotation
#
# Same 30-day cadence as dev. First rotation fires immediately
# after the module is applied; subsequent rotations follow the
# `automatically_after_days` schedule from the previous rotation.
# -----------------------------------------------------------------------------

module "secrets_rotation" {
  source = "../../modules/secrets"

  environment = "prod"
  region      = var.region

  rds_master_secret_arn    = module.rds.master_secret_arn
  private_subnet_ids       = module.vpc.private_subnet_ids
  lambda_security_group_id = module.vpc.lambda_security_group_id

  rotation_days = 30
  enabled       = true

  # Phase 9 Track 4 — grant the SAR-deployed rotation Lambda
  # `kms:Decrypt` on the secrets CMK so rotations continue to
  # work after the RDS master secret flips to the CMK. The
  # `enable_rotation_kms_permissions` boolean keeps `count` plan-
  # time-resolvable since the ARN itself is unknown at plan.
  secrets_kms_key_arn             = module.kms.secrets_key_arn
  enable_rotation_kms_permissions = true
}

output "secrets_rotation_enabled" {
  description = "Whether RDS password rotation is provisioned in prod."
  value       = module.secrets_rotation.rotation_enabled
}

output "secrets_rotation_lambda_name" {
  description = "Name of the rotation Lambda — operator uses for `aws logs tail` during incident response."
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
# Prod keeps the module-default 30-day deletion window. The keys
# carry `prevent_destroy = true` on top — the Terraform-side guard
# is a hard "you can't `terraform destroy` this key by mistake",
# while the 30-day window is the AWS-side recovery net for a
# `ScheduleKeyDeletion` call that did make it through.
# -----------------------------------------------------------------------------

module "kms" {
  source = "../../modules/kms"

  environment = "prod"
}

output "kms_key_arns" {
  description = "Map of service slug → CMK ARN for the prod env. Stands by unused until the consumer-wiring commit; surface here so the operator can review the plan before any data moves."
  value       = module.kms.key_arns
}

output "kms_alias_names" {
  description = "Map of service slug → alias name (`alias/ethiolink-prod-<service>`). Convenient for `aws kms describe-key --key-id <alias>` smoke checks after apply."
  value       = module.kms.alias_names
}
