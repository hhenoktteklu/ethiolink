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
    PAYMENTS_PROVIDER_CASH         = var.payments_provider_cash
    PAYMENTS_PROVIDER_ONLINE       = var.payments_provider_online
    BOOKING_CANCEL_CUTOFF_MINUTES  = tostring(var.booking_cancel_cutoff_minutes)
    BOOKING_SLOT_STEP_MINUTES      = tostring(var.booking_slot_step_minutes)
    BOOKING_BUFFER_MINUTES         = tostring(var.booking_buffer_minutes)
    DEFAULT_TIMEZONE               = var.default_timezone
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

# Baseline inline policy — every role gets `secretsmanager:GetSecretValue`
# on the RDS master secret. Without this the cold-start
# `loadSecretsThenConfig` shim throws before any handler logic
# runs, so EVERY domain needs it (including `maintenance`, which
# is the migration runner).
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
  ]
}
