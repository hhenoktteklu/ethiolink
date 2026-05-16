# EthioLink — Lambda deployment module.
#
# One `aws_lambda_function` per handler under `backend/lambdas/`,
# all running from the same pre-built `backend/dist/lambda.zip`
# archive. The runtime selects the correct entry by the `handler`
# attribute (`lambdas/<area>/<file>.handler`) — see the function
# map below.
#
# Why one shared zip:
#   The 49 handlers share the same `shared/` modules and the same
#   `node_modules` tree, so a per-handler zip would duplicate ~95%
#   of its content. AWS Lambda is fine loading a single 5–10 MB
#   zip and tree-shakes nothing at runtime, but the smaller surface
#   area for the deploy pipeline (one zip to upload, one
#   `source_code_hash` to track, one cache-invalidation cycle) is
#   the lever that matters during the MVP. Splitting is a
#   well-defined follow-up once a real cold-start budget violation
#   surfaces.
#
# IAM grouping:
#   The Phase 7 scoping note calls per-domain role grouping
#   acceptable for MVP; one shared role is even simpler. We use ONE
#   `lambda-exec` role per environment that carries:
#     * AWS-managed `AWSLambdaVPCAccessExecutionRole` (CloudWatch
#       logs + ENI lifecycle for VPC-attached Lambdas).
#     * `secretsmanager:GetSecretValue` on the RDS master secret.
#     * `s3:GetObject` / `s3:PutObject` on the two media buckets +
#       `s3:DeleteObject` on the private media bucket.
#   The follow-up commit that tightens the per-handler permissions
#   is paired with the API Gateway commit — that's the first call
#   site where the over-permissive role becomes observable.
#
# Password resolution:
#   `PG_PASSWORD` is NEVER set as a Lambda environment variable.
#   Lambda env vars are visible in plaintext in the AWS console
#   and in the Terraform state file; storing the DB password there
#   defeats Secrets Manager. Instead, every Lambda receives
#   `PG_SECRET_ARN = <master_secret_arn>` and the runtime resolves
#   it at cold-start before calling `loadConfig`. The cold-start
#   shim (`backend/shared/config/loadSecretsThenConfig.ts`) is a
#   separate, scheduled follow-up commit; until it lands, the
#   Lambdas WILL FAIL at startup because `loadConfig` requires
#   `PG_PASSWORD` to be present. The deferral is acceptable because
#   no Lambda is invocable until the API Gateway / EventBridge
#   commits wire trigger sources — until then, the functions exist
#   only as deployable artifacts. The shim commit is gated to land
#   before the smoke-test commit.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# -----------------------------------------------------------------------------
# Locals — the canonical function map.
#
# Each entry is the bare logical id (used in Terraform), the
# domain area (used in tags + role grouping references), and the
# handler path inside the zip (compiled JS path; the function's
# export is always named `handler`).
# -----------------------------------------------------------------------------

locals {
  base_name = "${var.name_prefix}-${var.environment}"

  common_tags = merge(
    {
      Component = "lambda"
      Module    = "lambda"
    },
    var.tags,
  )

  # 49 handlers across 12 domain areas. Logical id is
  # `<area>-<file>`; handler is `lambdas/<path>.handler` inside
  # the deployment zip.
  functions = {
    "auth-sync" = {
      area    = "auth"
      handler = "lambdas/auth/sync.handler"
    }
    "me-get" = {
      area    = "me"
      handler = "lambdas/me/get.handler"
    }
    "me-patch" = {
      area    = "me"
      handler = "lambdas/me/patch.handler"
    }
    "me-link-telegram-start" = {
      area    = "me"
      handler = "lambdas/me/linkTelegramStart.handler"
    }
    "me-link-telegram-status" = {
      area    = "me"
      handler = "lambdas/me/linkTelegramStatus.handler"
    }
    "me-link-telegram-unlink" = {
      area    = "me"
      handler = "lambdas/me/linkTelegramUnlink.handler"
    }
    "integrations-telegram-webhook" = {
      area    = "integrations"
      handler = "lambdas/integrations/telegramWebhook.handler"
    }
    # Phase 10 commit 3 — Chapa payment-success / payment-failure
    # webhook receiver. Gated by HMAC signature; calls the
    # featuring + appointment services to flip domain state.
    "integrations-chapa-webhook" = {
      area    = "integrations"
      handler = "lambdas/integrations/chapaWebhook.handler"
    }
    # Phase 10 commit 6 — admin reconciliation reads over the
    # `payment_intents` table. No writes; refund / void are
    # deferred to a Phase 10.5 follow-up alongside the refund
    # policy. Both functions sit under the existing `admin`
    # Lambda area + IAM role.
    "admin-payments-list-for-business" = {
      area    = "admin"
      handler = "lambdas/admin/payments/listForBusiness.handler"
    }
    "admin-payments-list" = {
      area    = "admin"
      handler = "lambdas/admin/payments/list.handler"
    }
    "categories-list" = {
      area    = "categories"
      handler = "lambdas/categories/list.handler"
    }
    "businesses-list" = {
      area    = "businesses"
      handler = "lambdas/businesses/list.handler"
    }
    "businesses-get" = {
      area    = "businesses"
      handler = "lambdas/businesses/get.handler"
    }
    "businesses-me" = {
      area    = "businesses"
      handler = "lambdas/businesses/me.handler"
    }
    "businesses-create" = {
      area    = "businesses"
      handler = "lambdas/businesses/create.handler"
    }
    "businesses-patch" = {
      area    = "businesses"
      handler = "lambdas/businesses/patch.handler"
    }
    "businesses-submit" = {
      area    = "businesses"
      handler = "lambdas/businesses/submit.handler"
    }
    "services-list" = {
      area    = "services"
      handler = "lambdas/services/list.handler"
    }
    "services-create" = {
      area    = "services"
      handler = "lambdas/services/create.handler"
    }
    "services-patch" = {
      area    = "services"
      handler = "lambdas/services/patch.handler"
    }
    "services-delete" = {
      area    = "services"
      handler = "lambdas/services/delete.handler"
    }
    "staff-list" = {
      area    = "staff"
      handler = "lambdas/staff/list.handler"
    }
    "staff-create" = {
      area    = "staff"
      handler = "lambdas/staff/create.handler"
    }
    "staff-patch" = {
      area    = "staff"
      handler = "lambdas/staff/patch.handler"
    }
    "staff-delete" = {
      area    = "staff"
      handler = "lambdas/staff/delete.handler"
    }
    "availability-get" = {
      area    = "availability"
      handler = "lambdas/availability/get.handler"
    }
    "availability-replace" = {
      area    = "availability"
      handler = "lambdas/availability/replace.handler"
    }
    "availability-add-override" = {
      area    = "availability"
      handler = "lambdas/availability/addOverride.handler"
    }
    "availability-slots" = {
      area    = "availability"
      handler = "lambdas/availability/slots.handler"
    }
    "appointments-create" = {
      area    = "appointments"
      handler = "lambdas/appointments/create.handler"
    }
    "appointments-list-mine" = {
      area    = "appointments"
      handler = "lambdas/appointments/listMine.handler"
    }
    "appointments-list-for-business" = {
      area    = "appointments"
      handler = "lambdas/appointments/listForBusiness.handler"
    }
    "appointments-accept" = {
      area    = "appointments"
      handler = "lambdas/appointments/accept.handler"
    }
    "appointments-reject" = {
      area    = "appointments"
      handler = "lambdas/appointments/reject.handler"
    }
    "appointments-cancel" = {
      area    = "appointments"
      handler = "lambdas/appointments/cancel.handler"
    }
    "appointments-reschedule" = {
      area    = "appointments"
      handler = "lambdas/appointments/reschedule.handler"
    }
    "appointments-complete" = {
      area    = "appointments"
      handler = "lambdas/appointments/complete.handler"
    }
    "appointments-review" = {
      area    = "appointments"
      handler = "lambdas/appointments/review.handler"
    }
    "reviews-list-for-business" = {
      area    = "reviews"
      handler = "lambdas/reviews/listForBusiness.handler"
    }
    "media-upload-url" = {
      area    = "media"
      handler = "lambdas/media/uploadUrl.handler"
    }
    "media-confirm" = {
      area    = "media"
      handler = "lambdas/media/confirm.handler"
    }
    "admin-businesses-list" = {
      area    = "admin"
      handler = "lambdas/admin/businesses/list.handler"
    }
    "admin-businesses-approve" = {
      area    = "admin"
      handler = "lambdas/admin/businesses/approve.handler"
    }
    "admin-businesses-reject" = {
      area    = "admin"
      handler = "lambdas/admin/businesses/reject.handler"
    }
    "admin-businesses-suspend" = {
      area    = "admin"
      handler = "lambdas/admin/businesses/suspend.handler"
    }
    "admin-businesses-feature" = {
      area    = "admin"
      handler = "lambdas/admin/businesses/feature.handler"
    }
    "admin-users-list" = {
      area    = "admin"
      handler = "lambdas/admin/users/list.handler"
    }
    "admin-users-suspend" = {
      area    = "admin"
      handler = "lambdas/admin/users/suspend.handler"
    }
    "admin-users-restore" = {
      area    = "admin"
      handler = "lambdas/admin/users/restore.handler"
    }
    "admin-categories-list" = {
      area    = "admin"
      handler = "lambdas/admin/categories/list.handler"
    }
    "admin-categories-create" = {
      area    = "admin"
      handler = "lambdas/admin/categories/create.handler"
    }
    "admin-categories-patch" = {
      area    = "admin"
      handler = "lambdas/admin/categories/patch.handler"
    }
    "admin-categories-delete" = {
      area    = "admin"
      handler = "lambdas/admin/categories/delete.handler"
    }
    "admin-appointments-list" = {
      area    = "admin"
      handler = "lambdas/admin/appointments/list.handler"
    }
    "admin-notifications-list" = {
      area    = "admin"
      handler = "lambdas/admin/notifications/list.handler"
    }
    "scheduled-send-reminders" = {
      area    = "scheduled"
      handler = "lambdas/scheduled/sendReminders.handler"
    }
    # Phase 9 Track 6 — paid featuring sweep. Runs every 15 minutes
    # (rule in the EventBridge module) to expire ACTIVE rows past
    # ends_at, GC PENDING_PAYMENT rows past their 10-minute TTL,
    # and recompute `business_profiles.featured_until`.
    "scheduled-featuring-sweep" = {
      area    = "scheduled"
      handler = "lambdas/scheduled/featuringSweep.handler"
    }

    # Phase 9 Track 6 — paid featuring HTTP handlers. All four
    # owner endpoints live under the dedicated `featuring` area so
    # the IAM split keeps featuring writes confined to a single
    # role.
    "featuring-list-packages" = {
      area    = "featuring"
      handler = "lambdas/featuring/listPackages.handler"
    }
    "featuring-get-active" = {
      area    = "featuring"
      handler = "lambdas/featuring/getActive.handler"
    }
    "featuring-subscribe" = {
      area    = "featuring"
      handler = "lambdas/featuring/subscribe.handler"
    }
    "featuring-list-history" = {
      area    = "featuring"
      handler = "lambdas/featuring/listHistory.handler"
    }
    # Phase 9 Track 6 — admin-side featuring endpoints. Kept in
    # the `admin` area to inherit the existing admin-role IAM
    # posture; the application layer enforces ADMIN role via
    # `authorizeAdmin`.
    "admin-featuring-list-history" = {
      area    = "admin"
      handler = "lambdas/admin/featuring/listHistory.handler"
    }
    "admin-featuring-comp" = {
      area    = "admin"
      handler = "lambdas/admin/featuring/comp.handler"
    }
    "admin-featuring-cancel" = {
      area    = "admin"
      handler = "lambdas/admin/featuring/cancel.handler"
    }

    # ----- Maintenance -----------------------------------------------------
    # Manually invoked via `aws lambda invoke` after every Terraform
    # apply that ships a new migration. Not wired to API Gateway or
    # EventBridge — operator-only.
    "maintenance-db-migrate" = {
      area    = "maintenance"
      handler = "lambdas/maintenance/dbMigrate.handler"
    }
  }

  # Shared env block — every function gets these. Per-function
  # tweaks happen via `function_overrides`, not per-key.
  shared_environment = {
    NODE_ENV                       = var.node_env
    LOG_LEVEL                      = var.log_level
    APP_REGION                     = var.region
    PG_HOST                        = var.pg_host
    PG_PORT                        = tostring(var.pg_port)
    PG_DATABASE                    = var.pg_database
    PG_USER                        = var.pg_user
    PG_SSL                         = "true"
    PG_SECRET_ARN                  = var.rds_master_secret_arn
    COGNITO_USER_POOL_ID           = var.cognito_user_pool_id
    COGNITO_APP_CLIENT_ID_MOBILE   = var.cognito_app_client_id_mobile
    COGNITO_APP_CLIENT_ID_ADMIN    = var.cognito_app_client_id_admin
    COGNITO_REGION                 = var.region
    S3_BUCKET_MEDIA_PUBLIC         = var.media_public_bucket
    S3_BUCKET_MEDIA_PRIVATE        = var.media_private_bucket
    S3_UPLOAD_URL_EXPIRES_SECONDS  = "900"
    S3_READ_URL_EXPIRES_SECONDS    = "3600"
    NOTIFICATIONS_PROVIDER         = var.notifications_provider
    SMS_PROVIDER_API_BASE_URL      = var.sms_provider_api_base_url
    SMS_PROVIDER_SENDER_ID         = var.sms_provider_sender_id
    SMS_PROVIDER_API_KEY_SECRET_ARN = var.sms_provider_api_key_secret_arn
    SMS_PROVIDER_NAME              = var.sms_provider_name
    SMS_PROVIDER_TIMEOUT_MS        = tostring(var.sms_provider_timeout_ms)
    TELEGRAM_BOT_USERNAME           = var.telegram_bot_username
    TELEGRAM_BOT_TOKEN_SECRET_ARN   = var.telegram_bot_token_secret_arn
    TELEGRAM_WEBHOOK_SECRET_ARN     = var.telegram_webhook_secret_arn
    TELEGRAM_PROVIDER_NAME          = var.telegram_provider_name
    TELEGRAM_LINK_CODE_TTL_SECONDS  = tostring(var.telegram_link_code_ttl_seconds)
    TELEGRAM_TIMEOUT_MS             = tostring(var.telegram_timeout_ms)
    PAYMENTS_PROVIDER_CASH         = var.payments_provider_cash
    PAYMENTS_PROVIDER_ONLINE       = var.payments_provider_online
    # Phase 10 — Chapa payment provider routing + config. The
    # selector flag drives `paymentGatewayFactory`; the rest of
    # the block is dormant when the secret ARNs are empty.
    PAYMENTS_PROVIDER                  = var.payments_provider
    PAYMENTS_TIMEOUT_MS                = tostring(var.payments_timeout_ms)
    CHAPA_API_BASE_URL                 = var.chapa_api_base_url
    CHAPA_RETURN_URL                   = var.chapa_return_url
    CHAPA_SECRET_KEY_SECRET_ARN        = var.chapa_secret_key_secret_arn
    CHAPA_WEBHOOK_SECRET_SECRET_ARN    = var.chapa_webhook_secret_secret_arn
    BOOKING_CANCEL_CUTOFF_MINUTES  = tostring(var.booking_cancel_cutoff_minutes)
    BOOKING_SLOT_STEP_MINUTES      = tostring(var.booking_slot_step_minutes)
    BOOKING_BUFFER_MINUTES         = tostring(var.booking_buffer_minutes)
    DEFAULT_TIMEZONE               = var.default_timezone
    # Phase 9 Track 6 — paid featuring config. `FEATURING_ENABLED`
    # gates the owner-facing endpoints; the sweep Lambda runs
    # regardless so existing ACTIVE rows expire on schedule. Prices
    # are env-tuneable so the operator can adjust without a deploy.
    FEATURING_ENABLED              = tostring(var.featuring_enabled)
    FEATURING_7D_PRICE_ETB         = tostring(var.featuring_7d_price_etb)
    FEATURING_30D_PRICE_ETB        = tostring(var.featuring_30d_price_etb)
  }
}

# -----------------------------------------------------------------------------
# IAM — one execution role per domain area.
#
# Phase 8 refactor: the single shared `lambda-exec` role from
# Phase 7 is replaced by 11 per-domain roles. Every role still
# carries the same baseline (CloudWatch logs + VPC ENI + Secrets
# Manager read on the RDS master secret); only the `media` area
# gets the S3 statements layered on top. This caps the blast
# radius of any one handler being compromised to the resources
# its domain actually touches.
#
# Why per-domain instead of per-handler:
#   Per-handler would mean 50 roles. Per-domain (11) is the
#   pragmatic split that closes the most-relevant security gap
#   without the operational cost of 50 trust-policy rotations.
#   A future Phase 8 follow-up narrows specific high-risk
#   handlers further (e.g. `admin-businesses-suspend` gets its
#   own write-side-only role) once incident learnings surface.
#
# Currently NONE of the non-media areas require any AWS service
# beyond Secrets Manager + Logs + ENI. The application layer
# accesses Cognito via the per-token JWT verify path (no IAM call)
# and reaches RDS via the network (no IAM call — Postgres-level
# auth handled by the resolved password). When a future Lambda
# needs `cognito-idp:*` or `s3:GetObject` on the logs bucket, the
# right move is to add a new statement to that area's policy
# rather than re-collapsing the roles.
# -----------------------------------------------------------------------------

locals {
  lambda_areas = toset([
    "auth",
    "me",
    "businesses",
    "services",
    "staff",
    "availability",
    "appointments",
    "reviews",
    "media",
    "admin",
    "scheduled",
    "maintenance",
    "integrations",
    # Phase 9 Track 6 — paid featuring HTTP handlers run under
    # this dedicated role so featuring writes can be scoped
    # independently from the broader `businesses` area.
    "featuring",
  ])
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda_exec" {
  for_each = local.lambda_areas

  name               = "${local.base_name}-lambda-exec-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json

  description = "EthioLink ${var.environment} Lambda execution role for the `${each.key}` domain. Carries CloudWatch logs + VPC ENI permissions (via AWS-managed policy) + Secrets Manager read on the RDS master secret. Media role additionally has S3 read/write on the media buckets."

  tags = merge(local.common_tags, {
    Area = each.key
  })
}

# AWS-managed policy covers `logs:CreateLogGroup` /
# `CreateLogStream` / `PutLogEvents` AND the EC2 ENI lifecycle
# permissions Lambda needs to attach into the VPC.
resource "aws_iam_role_policy_attachment" "lambda_vpc_access" {
  for_each = local.lambda_areas

  role       = aws_iam_role.lambda_exec[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Baseline inline policy — every role gets:
#
#   * `secretsmanager:GetSecretValue` on the RDS master secret —
#     the cold-start `loadSecretsThenConfig` shim throws before
#     any handler logic runs without it, so EVERY domain needs it
#     (including `maintenance`, which is the migration runner).
#
#   * `xray:PutTraceSegments` + `xray:PutTelemetryRecords` —
#     required by the AWS X-Ray daemon embedded in the Lambda
#     runtime when `tracing_config.mode = "Active"` (set on every
#     function below). Without these the daemon logs warnings on
#     every invocation and traces are dropped.
data "aws_iam_policy_document" "lambda_baseline" {
  statement {
    sid    = "ReadRdsMasterSecret"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [var.rds_master_secret_arn]
  }

  statement {
    sid    = "XRayWrite"
    effect = "Allow"

    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]

    # X-Ray APIs require `*` resource — they don't support
    # resource-level scoping. See the AWS X-Ray IAM reference.
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "lambda_baseline" {
  for_each = local.lambda_areas

  name   = "${local.base_name}-lambda-baseline-${each.key}"
  role   = aws_iam_role.lambda_exec[each.key].id
  policy = data.aws_iam_policy_document.lambda_baseline.json
}

# Media-only S3 policy. Only `media-upload-url` + `media-confirm`
# Lambdas touch S3 directly; the rest of the platform reads
# public media via direct-CDN URLs (no IAM call) and the private
# bucket via presigned URLs the media Lambdas already issue.
data "aws_iam_policy_document" "lambda_media_s3" {
  statement {
    sid    = "MediaBucketReadWrite"
    effect = "Allow"

    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]

    resources = [
      "${var.media_public_bucket_arn}/*",
      "${var.media_private_bucket_arn}/*",
    ]
  }

  statement {
    sid    = "MediaPrivateDelete"
    effect = "Allow"

    actions   = ["s3:DeleteObject"]
    resources = ["${var.media_private_bucket_arn}/*"]
  }

  # Required for issuing presigned URLs against either bucket —
  # the SDK calls HeadBucket / GetBucketLocation as part of the
  # signing flow.
  statement {
    sid    = "MediaBucketDescribe"
    effect = "Allow"

    actions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
    ]

    resources = [
      var.media_public_bucket_arn,
      var.media_private_bucket_arn,
    ]
  }
}

resource "aws_iam_role_policy" "lambda_media_s3" {
  name   = "${local.base_name}-lambda-media-s3"
  role   = aws_iam_role.lambda_exec["media"].id
  policy = data.aws_iam_policy_document.lambda_media_s3.json
}

# -----------------------------------------------------------------------------
# Phase 9 Track 4 — per-domain CMK grants.
#
# Two conditional policies, gated on the env stack having actually
# wired the matching CMK ARN through. Each policy is attached only
# when its key is set; when `null`, the existing AWS-managed-key
# posture continues to work without any KMS grant.
#
#   * `lambda_kms_secrets`     — `kms:Decrypt` on the secrets CMK,
#                                attached to EVERY per-domain role
#                                (every domain's cold-start path
#                                resolves the RDS master secret).
#   * `lambda_kms_media`       — `kms:Decrypt` +
#                                `kms:GenerateDataKey*` on the
#                                media-bucket CMK, attached ONLY
#                                to the `media` role.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "lambda_kms_secrets" {
  count = var.secrets_kms_key_arn == null ? 0 : 1

  statement {
    sid    = "DecryptRdsMasterSecretCmk"
    effect = "Allow"

    actions = ["kms:Decrypt"]

    resources = [var.secrets_kms_key_arn]

    # `kms:ViaService` matches the `kms` module's key policy
    # condition — the grant only applies when the call comes
    # through Secrets Manager, not a direct STS-assumed-role
    # invocation pretending to be Lambda.
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "lambda_kms_secrets" {
  for_each = var.secrets_kms_key_arn == null ? toset([]) : local.lambda_areas

  name   = "${local.base_name}-lambda-kms-secrets-${each.key}"
  role   = aws_iam_role.lambda_exec[each.key].id
  policy = data.aws_iam_policy_document.lambda_kms_secrets[0].json
}

data "aws_iam_policy_document" "lambda_kms_media" {
  count = var.s3_media_kms_key_arn == null ? 0 : 1

  statement {
    sid    = "DecryptMediaBucketCmk"
    effect = "Allow"

    # `Decrypt` covers GetObject; `GenerateDataKey*` covers
    # PutObject (S3 asks KMS for a fresh data key per object
    # write, or per bucket-key window when `bucket_key_enabled`).
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
      "kms:GenerateDataKey*",
    ]

    resources = [var.s3_media_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "lambda_kms_media" {
  count = var.s3_media_kms_key_arn == null ? 0 : 1

  name   = "${local.base_name}-lambda-kms-media"
  role   = aws_iam_role.lambda_exec["media"].id
  policy = data.aws_iam_policy_document.lambda_kms_media[0].json
}

# -----------------------------------------------------------------------------
# Phase 9 — SMS provider secret read.
#
# Attached ONLY to the `appointments` + `scheduled` roles — those
# two domains are the entire surface of notification dispatch
# (every booking-lifecycle handler + the reminder Lambda). Other
# domains (auth, businesses, admin, etc.) never construct an SMS
# gateway, so they don't need this permission.
#
# The policy is gated on `var.sms_provider_api_key_secret_arn`
# being non-empty so the dev / prod env stacks that haven't wired
# SMS get no extra IAM surface. When the operator wires the
# secret, this policy attaches automatically on next apply.
# -----------------------------------------------------------------------------

locals {
  sms_provider_secret_consumer_areas = (
    var.sms_provider_api_key_secret_arn != ""
    ? toset(["appointments", "scheduled"])
    : toset([])
  )
}

data "aws_iam_policy_document" "lambda_sms_provider_secret" {
  count = var.sms_provider_api_key_secret_arn != "" ? 1 : 0

  statement {
    sid    = "ReadSmsProviderApiKey"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [var.sms_provider_api_key_secret_arn]
  }
}

resource "aws_iam_role_policy" "lambda_sms_provider_secret" {
  for_each = local.sms_provider_secret_consumer_areas

  name   = "${local.base_name}-lambda-sms-provider-secret-${each.key}"
  role   = aws_iam_role.lambda_exec[each.key].id
  policy = data.aws_iam_policy_document.lambda_sms_provider_secret[0].json
}

# -----------------------------------------------------------------------------
# Phase 9 Track 2 — Telegram secret reads.
#
# The Telegram bot uses two secrets in Secrets Manager:
#
#   * `TELEGRAM_BOT_TOKEN_SECRET_ARN` — Bot API token from
#     BotFather. Used by the webhook Lambda to send confirmation
#     replies via `sendMessage`. Will also be used by every
#     notification dispatcher once the factory wires the Telegram
#     gateway in a later commit.
#
#   * `TELEGRAM_WEBHOOK_SECRET_ARN` — shared secret used to
#     authenticate Telegram → API GW callbacks via the
#     `X-Telegram-Bot-Api-Secret-Token` header. Only the webhook
#     Lambda needs to read this.
#
# Today only the `integrations` Lambda area constructs the
# `TelegramLinkService` + the bot-reply transport. The `me` area
# (the three link/start/status/unlink Lambdas) reads the linking
# config (bot username + code TTL) from the plain env block; it
# does NOT need either secret. When a future commit wires the
# Telegram notification gateway into the factory, the
# `appointments` + `scheduled` areas will gain the bot-token read
# too (same pattern as the SMS provider).
#
# Both policies are gated on the corresponding ARN being non-
# empty so env stacks that haven't wired Telegram get no extra IAM
# surface.
# -----------------------------------------------------------------------------

locals {
  # `integrations` always reads the bot token (for the webhook
  # confirmation reply). When Telegram is wired alongside the
  # notification dispatcher, `appointments` + `scheduled` also
  # need it so their cold-start `GenericTelegramGateway` can
  # authenticate to the Bot API. Mirrors the SMS pattern.
  telegram_bot_token_consumer_areas = (
    var.telegram_bot_token_secret_arn != ""
    ? toset(["integrations", "appointments", "scheduled"])
    : toset([])
  )
  # Only the `integrations` Lambda validates the inbound webhook
  # header; no other area needs the webhook secret.
  telegram_webhook_secret_consumer_areas = (
    var.telegram_webhook_secret_arn != ""
    ? toset(["integrations"])
    : toset([])
  )
}

data "aws_iam_policy_document" "lambda_telegram_bot_token" {
  count = var.telegram_bot_token_secret_arn != "" ? 1 : 0

  statement {
    sid    = "ReadTelegramBotToken"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [var.telegram_bot_token_secret_arn]
  }
}

resource "aws_iam_role_policy" "lambda_telegram_bot_token" {
  for_each = local.telegram_bot_token_consumer_areas

  name   = "${local.base_name}-lambda-telegram-bot-token-${each.key}"
  role   = aws_iam_role.lambda_exec[each.key].id
  policy = data.aws_iam_policy_document.lambda_telegram_bot_token[0].json
}

data "aws_iam_policy_document" "lambda_telegram_webhook_secret" {
  count = var.telegram_webhook_secret_arn != "" ? 1 : 0

  statement {
    sid    = "ReadTelegramWebhookSecret"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [var.telegram_webhook_secret_arn]
  }
}

resource "aws_iam_role_policy" "lambda_telegram_webhook_secret" {
  for_each = local.telegram_webhook_secret_consumer_areas

  name   = "${local.base_name}-lambda-telegram-webhook-secret-${each.key}"
  role   = aws_iam_role.lambda_exec[each.key].id
  policy = data.aws_iam_policy_document.lambda_telegram_webhook_secret[0].json
}

# -----------------------------------------------------------------------------
# Phase 10 — Chapa payment provider secret reads.
#
# Two Chapa secrets sit in Secrets Manager (same pattern as Telegram):
#
#   * `chapa_secret_key_secret_arn` — merchant secret key
#     (`CHASECK_…`) used by `ChapaGateway` to authenticate
#     `/v1/transaction/initialize` + `/v1/transaction/verify`
#     calls. Read by `appointments` (booking authorize), `featuring`
#     (subscription authorize), and `integrations` (webhook handler
#     issuing the verify round-trip — Phase 10 commit 3).
#
#   * `chapa_webhook_secret_secret_arn` — HMAC signing secret used
#     by the future webhook Lambda to validate inbound Chapa
#     callbacks. Read only by `integrations`.
#
# Both policies are gated on their ARN being non-empty so env
# stacks that haven't wired Chapa get no extra IAM surface — the
# default `payments_provider = "mock"` path adds zero grants.
# -----------------------------------------------------------------------------

locals {
  # Three areas consume the Chapa secret key. The `appointments` +
  # `featuring` roles authorize through the gateway at booking /
  # subscribe time; the `integrations` role calls `verify` from the
  # webhook handler (Phase 10 commit 3).
  chapa_secret_key_consumer_areas = (
    var.chapa_secret_key_secret_arn != ""
    ? toset(["appointments", "featuring", "integrations"])
    : toset([])
  )
  # Only the webhook handler validates the HMAC header against the
  # webhook secret. No other area needs this read.
  chapa_webhook_secret_consumer_areas = (
    var.chapa_webhook_secret_secret_arn != ""
    ? toset(["integrations"])
    : toset([])
  )
}

data "aws_iam_policy_document" "lambda_chapa_secret_key" {
  count = var.chapa_secret_key_secret_arn != "" ? 1 : 0

  statement {
    sid    = "ReadChapaSecretKey"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [var.chapa_secret_key_secret_arn]
  }
}

resource "aws_iam_role_policy" "lambda_chapa_secret_key" {
  for_each = local.chapa_secret_key_consumer_areas

  name   = "${local.base_name}-lambda-chapa-secret-key-${each.key}"
  role   = aws_iam_role.lambda_exec[each.key].id
  policy = data.aws_iam_policy_document.lambda_chapa_secret_key[0].json
}

data "aws_iam_policy_document" "lambda_chapa_webhook_secret" {
  count = var.chapa_webhook_secret_secret_arn != "" ? 1 : 0

  statement {
    sid    = "ReadChapaWebhookSecret"
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [var.chapa_webhook_secret_secret_arn]
  }
}

resource "aws_iam_role_policy" "lambda_chapa_webhook_secret" {
  for_each = local.chapa_webhook_secret_consumer_areas

  name   = "${local.base_name}-lambda-chapa-webhook-secret-${each.key}"
  role   = aws_iam_role.lambda_exec[each.key].id
  policy = data.aws_iam_policy_document.lambda_chapa_webhook_secret[0].json
}

# -----------------------------------------------------------------------------
# Log groups — one per function, retention enforced by the module.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "function" {
  for_each = local.functions

  name              = "/aws/lambda/${local.base_name}-${each.key}"
  retention_in_days = var.log_retention_days

  tags = merge(local.common_tags, {
    Name = "/aws/lambda/${local.base_name}-${each.key}"
    Area = each.value.area
  })
}

# -----------------------------------------------------------------------------
# Functions — for_each over the canonical map.
# -----------------------------------------------------------------------------

resource "aws_lambda_function" "function" {
  for_each = local.functions

  function_name = "${local.base_name}-${each.key}"
  description   = "EthioLink ${var.environment} — ${each.key}"

  # Pick the per-domain role keyed by the function's `area` tag.
  # Every function in the same domain shares one role; the
  # cross-domain blast-radius cap is what this Phase 8 split buys.
  role             = aws_iam_role.lambda_exec[each.value.area].arn
  runtime          = var.runtime
  handler          = each.value.handler
  filename         = var.package_zip_path
  source_code_hash = filebase64sha256(var.package_zip_path)

  memory_size = try(
    var.function_overrides[each.key].memory_size_mb,
    null,
  ) != null ? var.function_overrides[each.key].memory_size_mb : var.memory_size_mb

  timeout = try(
    var.function_overrides[each.key].timeout_seconds,
    null,
  ) != null ? var.function_overrides[each.key].timeout_seconds : var.timeout_seconds

  vpc_config {
    subnet_ids         = var.private_subnet_ids
    security_group_ids = [var.lambda_security_group_id]
  }

  # Phase 9 Track 4 — `null` keeps the AWS-managed `aws/lambda`
  # key (existing behavior). A non-null value re-encrypts the
  # env-var blob in place under the customer-managed CMK on the
  # next apply; new invocations decrypt under the CMK
  # transparently because the `kms` module's key policy already
  # grants `lambda.amazonaws.com` use of the key.
  kms_key_arn = var.env_kms_key_arn

  # Phase 8: enable AWS X-Ray tracing on every function. Sets the
  # `AWS_XRAY_DAEMON_ADDRESS` env var the runtime + the
  # `shared/observability/tracing.ts` helper detect; the IAM
  # baseline above grants the `xray:Put*` actions the daemon
  # needs. Lambda-level traces (cold-start, duration, errors)
  # light up immediately; SDK-call sub-segments require the
  # `aws-xray-sdk-core` package + per-client wrapping, which
  # lands in a follow-up commit.
  tracing_config {
    mode = "Active"
  }

  environment {
    # Shared env merged with any per-function override. The merge
    # order makes the override value win on key collision — exactly
    # what we want for the prod migration runner's `PG_HOST`
    # rewrite (proxy → direct DB endpoint).
    variables = merge(
      local.shared_environment,
      lookup(var.function_env_overrides, each.key, {}),
    )
  }

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-${each.key}"
    Area = each.value.area
  })

  # Ensure the log group exists with the desired retention before
  # the function logs anything — otherwise Lambda auto-creates the
  # log group with the AWS default ("never expire"), which we
  # override here. The IAM `depends_on` entries make sure every
  # role-attached policy is in place before Lambda tries to use
  # the role (otherwise the first invocation can race the policy
  # propagation and 403 on Secrets Manager).
  depends_on = [
    aws_cloudwatch_log_group.function,
    aws_iam_role_policy.lambda_baseline,
    aws_iam_role_policy.lambda_media_s3,
    aws_iam_role_policy_attachment.lambda_vpc_access,
    # Phase 9 Track 4 — when the secrets / media CMKs are wired,
    # the policies must be in place before the function first
    # invokes (otherwise the cold-start `loadSecretsThenConfig`
    # path races the policy propagation and 403s on KMS).
    aws_iam_role_policy.lambda_kms_secrets,
    aws_iam_role_policy.lambda_kms_media,
  ]
}
