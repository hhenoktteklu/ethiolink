# EthioLink — Lambda module inputs.
#
# This module deploys every EthioLink Lambda from a single
# pre-built zip archive produced by `backend/scripts/package.sh`.
# Each `aws_lambda_function` references the same zip but a
# different `handler` path — the runtime selects the correct
# entry by name. The MVP tradeoff is small-but-real cold-start
# overhead (every function loads the full bundle) for vastly
# simpler tooling. The first per-function cold-start budget
# violation is the trigger to split into one zip per handler.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in function names, log groups, and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment + area + handler to form function names like \"ethiolink-dev-auth-sync\"."
  type        = string
  default     = "ethiolink"
}

variable "region" {
  description = "AWS region. Threaded into the `APP_REGION` / `COGNITO_REGION` Lambda env vars so `loadConfig` doesn't fall back to its default."
  type        = string
  default     = "eu-west-1"
}

# -----------------------------------------------------------------------------
# Deployment package
# -----------------------------------------------------------------------------

variable "package_zip_path" {
  description = "Absolute path to the pre-built deployment zip. Produced by `backend/scripts/package.sh` at `backend/dist/lambda.zip`. The package contains the compiled `lambdas/`, `shared/`, and production `node_modules`. Re-running the script after a code change updates the zip; Terraform detects the change via `source_code_hash` (computed inside the module) and rolls each function to the new version."
  type        = string
}

# -----------------------------------------------------------------------------
# VPC config — every Lambda attaches to the VPC so it can reach RDS.
# -----------------------------------------------------------------------------

variable "private_subnet_ids" {
  description = "Private subnet ids the Lambdas run in. Sourced from the `vpc` module."
  type        = list(string)
}

variable "lambda_security_group_id" {
  description = "Security group attached to every Lambda. Egress-only — Lambdas don't accept inbound TCP. Sourced from the `vpc` module."
  type        = string
}

# -----------------------------------------------------------------------------
# Backing service identifiers — assembled into Lambda env vars.
# -----------------------------------------------------------------------------

variable "pg_host" {
  description = "Postgres host. Dev passes `rds.db_endpoint` (direct); prod passes `rds.proxy_endpoint` (proxy) — the module is oblivious to which is which. `effective_endpoint` from the RDS module is the right shortcut for both."
  type        = string
}

variable "pg_port" {
  description = "Postgres port. Default 5432, sourced from `rds.db_port` for symmetry with the rest of the wiring."
  type        = number
  default     = 5432
}

variable "pg_database" {
  description = "Database name. Sourced from `rds.db_name`."
  type        = string
}

variable "pg_user" {
  description = "Postgres role the Lambdas authenticate as. Same as the RDS master username today; future least-privilege application-role split lives in a separate commit."
  type        = string
}

variable "rds_master_secret_arn" {
  description = "ARN of the Secrets Manager secret carrying the master credentials. Threaded into every Lambda's `PG_SECRET_ARN` env var. PASSWORDS ARE NOT PASSED THROUGH PLAINTEXT — see the module header for the cold-start resolution pattern."
  type        = string
}

variable "cognito_user_pool_id" {
  description = "Cognito user pool id. Sourced from the `cognito` module."
  type        = string
}

variable "cognito_app_client_id_mobile" {
  description = "Cognito mobile app client id. Sourced from the `cognito` module."
  type        = string
}

variable "cognito_app_client_id_admin" {
  description = "Cognito admin app client id. Sourced from the `cognito` module."
  type        = string
}

variable "media_public_bucket" {
  description = "Public media bucket name. Maps to `S3_BUCKET_MEDIA_PUBLIC`."
  type        = string
}

variable "media_private_bucket" {
  description = "Private media bucket name. Maps to `S3_BUCKET_MEDIA_PRIVATE`."
  type        = string
}

variable "media_public_bucket_arn" {
  description = "Public media bucket ARN. Threaded into the Lambda execution-role IAM policy for `s3:PutObject` / `s3:GetObject`."
  type        = string
}

variable "media_private_bucket_arn" {
  description = "Private media bucket ARN. Same as above plus `s3:DeleteObject` to support a future cleanup flow."
  type        = string
}

# -----------------------------------------------------------------------------
# Runtime knobs
# -----------------------------------------------------------------------------

variable "runtime" {
  description = "Lambda runtime identifier. Pinned to Node.js 20 — matches the backend's tsconfig target + `engines.node`."
  type        = string
  default     = "nodejs20.x"
}

variable "memory_size_mb" {
  description = "Default memory size per function in MiB. MVP runs everything at 256 — the Postgres driver + Cognito JWT verifier fit comfortably. Bumps live per-function in `function_overrides` once a real workload demands it."
  type        = number
  default     = 256
}

variable "timeout_seconds" {
  description = "Default per-invocation timeout. 30s is generous for an MVP request path; the scheduled reminder lambda overrides to a higher value in `function_overrides` once its batch size warrants it."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  description = "CloudWatch log group retention. Dev 30 days, prod 90 days per `AWS_DEPLOYMENT.md`."
  type        = number
  default     = 30

  validation {
    # AWS-permitted retention values; 0 means "never expire" but we
    # never want that for cost reasons.
    condition = contains(
      [1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1827, 3653],
      var.log_retention_days,
    )
    error_message = "log_retention_days must be one of the AWS-permitted retention values."
  }
}

# -----------------------------------------------------------------------------
# Application-policy defaults — sourced from `backend/.env.example`.
# -----------------------------------------------------------------------------

variable "notifications_provider" {
  description = "Notification provider routing key. `mock` keeps `MockNotificationGateway` as the only wired gateway. `sms` opts in to `GenericSmsGateway` when the SMS provider config is set. `telegram` opts in to `GenericTelegramGateway` when the Telegram provider config is set. `production` opts in to BOTH SMS and Telegram (each still gated on its per-vendor config block being non-empty). The factory in `notificationServiceFactory.ts` evaluates this at cold-start."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "sms", "telegram", "production"], var.notifications_provider)
    error_message = "notifications_provider must be one of: mock, sms, telegram, production."
  }
}

# -----------------------------------------------------------------------------
# Phase 9 — SMS provider config.
#
# All four variables default to empty so the existing dev / prod
# env stacks remain valid without any change. Operators wire a
# real provider by setting all of:
#
#   * `sms_provider_api_base_url`        — vendor REST endpoint
#                                          (e.g. https://api.afromessage.com)
#   * `sms_provider_sender_id`           — sender display name
#                                          registered with the
#                                          vendor (e.g. "EthioLink")
#   * `sms_provider_api_key_secret_arn`  — Secrets Manager ARN
#                                          holding the API key.
#                                          `loadSecretsThenConfig`
#                                          resolves this into
#                                          `SMS_PROVIDER_API_KEY`
#                                          at cold start.
#   * `notifications_provider = "sms"`   — provider flag.
#
# When ANY of the three vendor vars is empty, `loadConfig` builds
# `config.smsProvider = null` and the factory keeps the SMS channel
# unmapped — `MockNotificationGateway` continues to handle every
# dispatch. This makes the SMS rollout strictly opt-in.
# -----------------------------------------------------------------------------

variable "sms_provider_api_base_url" {
  description = "SMS vendor REST base URL (e.g. `https://api.afromessage.com`). Empty when SMS is not wired."
  type        = string
  default     = ""
}

variable "sms_provider_sender_id" {
  description = "Sender display name registered with the SMS vendor. Empty when SMS is not wired."
  type        = string
  default     = ""
}

variable "sms_provider_api_key_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the SMS provider API key. SecretString must be either the plain API key OR a JSON object with an `apiKey` field. Empty when SMS is not wired. When set, only the `appointments` and `scheduled` Lambda IAM roles get `secretsmanager:GetSecretValue` scoped to this ARN — other domains continue to lack the permission."
  type        = string
  default     = ""
}

variable "sms_provider_name" {
  description = "Provider identifier written to `notification_logs.provider`. Free-form; defaults to `GENERIC_SMS`. Operators can set this to the chosen vendor name (e.g. `AFRO_MESSAGE`) for clearer log inspection."
  type        = string
  default     = ""
}

variable "sms_provider_timeout_ms" {
  description = "HTTP request timeout for the SMS provider, in milliseconds. Default 10000 (10s)."
  type        = number
  default     = 10000
}

# -----------------------------------------------------------------------------
# Phase 9 Track 2 — Telegram provider config.
#
# Like the SMS block, all five variables default to empty so the
# existing env stacks remain valid without any change. Operators
# wire the bot by setting:
#
#   * `telegram_bot_username`              — bot username (without
#                                            the leading `@`), used
#                                            by the linking deep
#                                            link.
#   * `telegram_bot_token_secret_arn`      — Secrets Manager ARN
#                                            holding the bot token
#                                            from BotFather. The
#                                            `integrations` Lambda
#                                            IAM role gains a
#                                            scoped read on this
#                                            ARN.
#   * `telegram_webhook_secret_arn`        — Secrets Manager ARN
#                                            holding the
#                                            `setWebhook` secret.
#                                            Used by the webhook
#                                            Lambda to validate
#                                            the
#                                            `X-Telegram-Bot-Api-Secret-Token`
#                                            header.
#
# Until both ARNs are set, `config.telegramProvider` resolves to
# `null` and the four Telegram handlers return 503 on every call.
# This makes the rollout strictly opt-in.
# -----------------------------------------------------------------------------

variable "telegram_bot_username" {
  description = "Telegram bot username without the leading `@` (e.g. `EthioLinkBot`). Empty when Telegram is not wired."
  type        = string
  default     = ""
}

variable "telegram_bot_token_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the Telegram bot token (from BotFather). SecretString may be a plain string OR a JSON object with a `botToken` field. Empty when Telegram is not wired. When set, only the `integrations` Lambda IAM role gets `secretsmanager:GetSecretValue` scoped to this ARN."
  type        = string
  default     = ""
}

variable "telegram_webhook_secret_arn" {
  description = "ARN of the Secrets Manager secret holding the webhook secret. SecretString may be plain OR `{ webhookSecret: '…' }`. Empty when Telegram is not wired. When set, only the `integrations` Lambda IAM role gets read scoped to this ARN."
  type        = string
  default     = ""
}

variable "telegram_provider_name" {
  description = "Provider identifier written to `notification_logs.provider` once the gateway is wired. Free-form; defaults to `TELEGRAM_BOT`."
  type        = string
  default     = ""
}

variable "telegram_link_code_ttl_seconds" {
  description = "TTL for issued Telegram linking codes, in seconds. Default 600 (10 minutes)."
  type        = number
  default     = 600
}

variable "telegram_timeout_ms" {
  description = "HTTP request timeout for the Telegram Bot API, in milliseconds. Default 10000 (10s)."
  type        = number
  default     = 10000
}

variable "payments_provider_cash" {
  description = "Cash-path provider name. Always `cash` in MVP."
  type        = string
  default     = "cash"
}

variable "payments_provider_online" {
  description = "Online-path provider name. `mock` until Telebirr / Chapa / CBE Birr land."
  type        = string
  default     = "mock"
}

variable "booking_cancel_cutoff_minutes" {
  description = "Customer-initiated cancellation cutoff. Defaults to 240 minutes (4 hours) — matches `backend/.env.example` and the test suite."
  type        = number
  default     = 240
}

variable "booking_slot_step_minutes" {
  description = "Slot grid step size. Matches the docker-compose default."
  type        = number
  default     = 15
}

variable "booking_buffer_minutes" {
  description = "Per-appointment buffer used by slot computation. Matches the docker-compose default."
  type        = number
  default     = 5
}

variable "default_timezone" {
  description = "IANA timezone for slot computation + template rendering. Defaults to `Africa/Addis_Ababa`."
  type        = string
  default     = "Africa/Addis_Ababa"
}

variable "log_level" {
  description = "Application log level. `info` for dev, sometimes `debug` for prod incident response, never above `info` in steady state."
  type        = string
  default     = "info"

  validation {
    condition     = contains(["debug", "info", "warn", "error"], var.log_level)
    error_message = "log_level must be one of: debug, info, warn, error."
  }
}

variable "node_env" {
  description = "Value of the `NODE_ENV` env var. Either `production` (prod / dev) or `development` (laptop). Production silences development-only logging paths in some downstream deps."
  type        = string
  default     = "production"
}

variable "function_overrides" {
  description = "Per-function knobs that diverge from the module defaults. Map keyed by the function's logical id (e.g. `appointments-create`); each value can override `memory_size_mb` and `timeout_seconds`. Empty map = every function uses the module defaults."
  type = map(object({
    memory_size_mb  = optional(number)
    timeout_seconds = optional(number)
  }))
  default = {}
}

variable "function_env_overrides" {
  description = "Per-function environment-variable overrides merged on top of the shared env block. Map keyed by the function's logical id; the inner map's keys override matching keys in the shared env, additional keys are appended. Currently used in prod to point `maintenance-db-migrate` at the direct RDS endpoint while every other function targets the proxy. Empty map = every function gets exactly the shared env."
  type    = map(map(string))
  default = {}
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Phase 9 Track 4 — KMS inputs.
#
# Five nullable CMK ARNs threaded down from the `kms` module via
# the env stack. Each defaults to `null` so the existing
# AWS-managed-encryption posture survives without any change. When
# set:
#
#   * `env_kms_key_arn`        — every `aws_lambda_function` in
#                                this module gets
#                                `kms_key_arn = <arn>`. Lambda
#                                re-encrypts env-var blobs in
#                                place on the next apply (no
#                                cold-start downtime). The
#                                `lambda.amazonaws.com` service
#                                principal already has use of the
#                                key via the `kms` module's key
#                                policy.
#   * `secrets_kms_key_arn`    — every per-domain Lambda role
#                                gains a scoped `kms:Decrypt`
#                                grant on this key. Required so
#                                the cold-start `loadSecretsThenConfig`
#                                shim can decrypt the RDS master
#                                secret when it lives under the
#                                CMK.
#   * `s3_media_kms_key_arn`   — the `media` Lambda role gains
#                                scoped `kms:Decrypt` +
#                                `kms:GenerateDataKey*` on the
#                                media-bucket CMK. PutObject /
#                                GetObject paths against the
#                                CMK-encrypted media buckets need
#                                both actions.
#   * `rds_kms_key_arn`        — present for completeness /
#                                documentation; the application
#                                Lambdas never call KMS for RDS
#                                directly (RDS decrypts storage
#                                internally), so no IAM grant is
#                                added today. Recorded here so a
#                                future feature requiring direct
#                                RDS-snapshot access has the
#                                wiring already.
#   * `sms_provider_kms_key_arn` /
#     `telegram_kms_key_arn`   — placeholders for the future
#                                third-party API-key secrets. Not
#                                used today (the existing
#                                secrets-ARN grants don't need
#                                KMS perms until those secrets
#                                actually live under a CMK).
# -----------------------------------------------------------------------------

variable "env_kms_key_arn" {
  description = "ARN of the customer-managed KMS key used to encrypt every Lambda function's environment-variable blob at rest. `null` (the default) keeps the AWS-managed `aws/lambda` key. The change is applied immediately on the next `aws_lambda_function` update — Lambda re-encrypts env vars in place without a cold-start hit."
  type        = string
  default     = null
}

variable "secrets_kms_key_arn" {
  description = "ARN of the customer-managed KMS key used by the RDS master secret + future third-party API-key secrets. When set, every per-domain Lambda role gains a scoped `kms:Decrypt` grant on this key so `loadSecretsThenConfig` can read the RDS master secret. `null` keeps the AWS-managed `aws/secretsmanager` posture and adds no grant."
  type        = string
  default     = null
}

variable "s3_media_kms_key_arn" {
  description = "ARN of the customer-managed KMS key used to encrypt the media buckets. When set, the `media` Lambda role gains scoped `kms:Decrypt` + `kms:GenerateDataKey*` on this key — both actions are required for PutObject / GetObject against SSE-KMS buckets. `null` keeps the SSE-S3 posture and adds no grant."
  type        = string
  default     = null
}
