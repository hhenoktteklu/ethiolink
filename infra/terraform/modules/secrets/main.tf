# EthioLink — Secrets Manager rotation module.
#
# Provisions:
#
#   * The AWS-published `SecretsManagerRDSPostgreSQLRotationSingleUser`
#     rotation Lambda from the AWS Serverless Application
#     Repository (SAR). The Lambda lives in the application VPC
#     (private subnets, `sg-lambda` ingress posture) so it can
#     reach RDS over the Postgres wire to `ALTER USER` the master
#     password.
#
#   * `aws_secretsmanager_secret_rotation` binding the RDS master
#     secret to the rotation Lambda, scheduling rotation every
#     `var.rotation_days` (default 30).
#
# Why SAR instead of building the rotation Lambda ourselves:
#   AWS maintains the four-step rotation logic (`createSecret` /
#   `setSecret` / `testSecret` / `finishSecret`) including the
#   PostgreSQL-specific `ALTER USER ... WITH PASSWORD` SQL.
#   Re-implementing it would duplicate code AWS already
#   maintains; the SAR template handles the IAM policy, the
#   VPC config, and the secret-resource-policy update required
#   to let Secrets Manager invoke the rotation Lambda.
#
# Cache caveat (documented in `loadSecretsThenConfig`):
#   The application Lambdas cache the resolved secret at module
#   scope (one cache per warm container). When a rotation
#   happens, warm containers continue holding the previous
#   password until the container is recycled — usually a few
#   minutes, never more than ~30 minutes per AWS's Lambda
#   recycle policy. New cold starts pick up the rotated value
#   automatically because `loadSecretsThenConfig` re-resolves
#   on every cold start. The intermediate-state behavior is
#   handled by AWS's rotation strategy: the secret's
#   AWSPREVIOUS stage continues to authenticate against RDS
#   until the next rotation, so warm containers that try the
#   old password still succeed. No application changes needed.
#
# Disable knob (`var.enabled = false`):
#   When `false`, the module creates no resources. The existing
#   secret keeps whatever password it has. Useful for an
#   environment that wants to halt rotation while debugging an
#   upstream issue (e.g. a misconfigured rotation Lambda from
#   an earlier SAR version).

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  base_name             = "${var.name_prefix}-${var.environment}"
  rotation_lambda_name  = "${local.base_name}-rds-rotation"

  # SAR application identifier for the AWS-published rotation
  # Lambda. The ARN's region (`us-east-1`) is the SAR catalog
  # region — the Lambda itself is created in `var.region`.
  sar_application_id = "arn:aws:serverlessrepo:us-east-1:297356227824:applications/SecretsManagerRDSPostgreSQLRotationSingleUser"

  common_tags = merge(
    {
      Component = "secrets"
      Module    = "secrets"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# Rotation Lambda — deployed via SAR.
# -----------------------------------------------------------------------------

resource "aws_serverlessapplicationrepository_cloudformation_stack" "rotation" {
  count = var.enabled ? 1 : 0

  name = local.rotation_lambda_name

  application_id = local.sar_application_id

  # SAR templates that create IAM resources require explicit
  # capability acknowledgement. The rotation template creates
  # the rotation Lambda's execution role + a resource policy on
  # the rotation Lambda itself.
  capabilities = [
    "CAPABILITY_IAM",
    "CAPABILITY_RESOURCE_POLICY",
  ]

  parameters = {
    endpoint            = "https://secretsmanager.${var.region}.amazonaws.com"
    functionName        = local.rotation_lambda_name
    vpcSubnetIds        = join(",", var.private_subnet_ids)
    vpcSecurityGroupIds = var.lambda_security_group_id

    # Single-user pattern — the rotation Lambda rotates the
    # master credentials directly (no separate "user" account).
    # AWS recommends multi-user for production at scale, but the
    # single-user pattern is the right MVP starting point and
    # the rotation logic is identical at the application layer.
  }

  tags = merge(local.common_tags, {
    Name = local.rotation_lambda_name
  })
}

# Look up the deployed rotation Lambda by name so we can bind it
# to the secret. The SAR stack's outputs differ across template
# versions; a data-source lookup by function name is the stable
# way to reach the ARN.
data "aws_lambda_function" "rotation" {
  count = var.enabled ? 1 : 0

  function_name = local.rotation_lambda_name

  depends_on = [aws_serverlessapplicationrepository_cloudformation_stack.rotation]
}

# -----------------------------------------------------------------------------
# Rotation schedule.
# -----------------------------------------------------------------------------

resource "aws_secretsmanager_secret_rotation" "rds" {
  count = var.enabled ? 1 : 0

  secret_id           = var.rds_master_secret_arn
  rotation_lambda_arn = data.aws_lambda_function.rotation[0].arn

  rotation_rules {
    automatically_after_days = var.rotation_days
  }

  # The first rotation runs immediately after this resource is
  # created (AWS default) — that's the right posture for a fresh
  # secret because it validates the rotation Lambda actually
  # works before the next 30-day window. Subsequent rotations
  # run every `rotation_days` from the previous rotation.
}

# -----------------------------------------------------------------------------
# Phase 9 Track 4 — CMK grant for the SAR-deployed rotation Lambda.
#
# When `var.enable_rotation_kms_permissions` is `true` (= the
# operator has wired the secrets CMK on the secret and wants the
# rotation Lambda to keep working), the rotation Lambda needs
# `kms:Decrypt` on the CMK to read the current secret value
# before rotating. The SAR template doesn't grant any KMS
# permission by default, so we attach an inline policy to the
# Lambda's execution role.
#
# Role lookup: the SAR template names the role after the function;
# the data-source for the function gives us its role ARN, from
# which we extract the role name.
# -----------------------------------------------------------------------------

# `count` MUST be known at plan time. The original gate
# `var.secrets_kms_key_arn != null` tripped Terraform when the env
# stack passed `module.kms.secrets_key_arn` (the ARN is computed by
# the `kms` module and therefore unknown until apply). Gating on
# the explicit boolean `enable_rotation_kms_permissions` keeps the
# count statically resolvable; the ARN is still consumed inside the
# policy document's `Resource` and resolves at apply time.

locals {
  # `arn:aws:iam::123456789012:role/<name>` → `<name>`.
  rotation_role_name = (var.enabled && var.enable_rotation_kms_permissions) ? element(
    split("/", data.aws_lambda_function.rotation[0].role),
    1,
  ) : ""
}

data "aws_iam_policy_document" "rotation_kms" {
  count = (var.enabled && var.enable_rotation_kms_permissions) ? 1 : 0

  statement {
    sid    = "DecryptRdsMasterSecretCmk"
    effect = "Allow"

    actions = ["kms:Decrypt"]

    resources = [var.secrets_kms_key_arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "rotation_kms" {
  count = (var.enabled && var.enable_rotation_kms_permissions) ? 1 : 0

  name   = "${local.rotation_lambda_name}-kms-decrypt"
  role   = local.rotation_role_name
  policy = data.aws_iam_policy_document.rotation_kms[0].json
}
