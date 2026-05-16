# EthioLink — customer-managed KMS keys.
#
# Phase 9 Track 4 commit "add KMS module". Provisions one
# customer-managed KMS key + alias per consuming service:
#
#   * `rds`                  — encrypts the Postgres instance, its
#                              automated snapshots, and the
#                              `ethiolink/${env}/rds/master` secret
#                              once wired through the RDS module.
#   * `s3_media`             — encrypts the public + private media
#                              buckets (`media-public`,
#                              `media-private`).
#   * `s3_logs`              — encrypts the S3 server-access-logs
#                              bucket. Kept separate from `s3_media`
#                              so an audit-side RW grant on logs
#                              doesn't have to widen to the
#                              customer-facing media data.
#   * `s3_admin_frontend`    — encrypts the admin SPA bucket. OAC
#                              via CloudFront's service principal
#                              still works; the key policy grants
#                              `cloudfront.amazonaws.com` use of
#                              the key for the bucket OAC reads.
#   * `secrets`              — encrypts Secrets Manager entries
#                              (today: the RDS master secret;
#                              future: third-party API keys like
#                              SMS / Telegram / payment providers).
#   * `lambda_env`           — encrypts Lambda environment-variable
#                              blobs at rest.
#
# Each key:
#
#   * Uses `SYMMETRIC_DEFAULT` (the AES-GCM 256 variant AWS uses
#     for all data-at-rest service integrations).
#   * Has `enable_key_rotation = true` (annual automated rotation
#     managed by AWS — the operator does not need to do anything
#     when rotation fires; the previous backing key material stays
#     available to decrypt historical ciphertexts).
#   * Lives forever on `prevent_destroy = true` against accidental
#     `terraform destroy`. The `deletion_window_in_days` is the
#     real safety net for an intentional teardown (default 30
#     days; the env stack overrides to 7 in dev for faster
#     throwaway).
#   * Has a key policy with two statements:
#       (a) Account-root admin grant — the standard "allow root to
#           administer this key" boilerplate every AWS-recommended
#           key policy carries. Without this the operator can
#           lock themselves out of the key (a key with no admin
#           statement is unusable AND undeleteable from the
#           console; the only recovery is an AWS Support
#           ticket).
#       (b) Service-principal use grant — limits `kms:Encrypt`,
#           `kms:Decrypt`, `kms:ReEncrypt*`, and
#           `kms:GenerateDataKey*` to the AWS service principal
#           that the key is paired with (RDS, S3, Secrets
#           Manager, Lambda, CloudFront). Gated through the
#           `kms:ViaService` condition where AWS supports it —
#           that adds the second guardrail that the call must
#           come *through* the named service, not directly via
#           an STS-assumed role pretending to be the service.
#
# **Important — this commit is purely additive.** No existing
# resource flips to a CMK in this commit. The consumer modules
# (rds, s3, secrets, lambda) keep their AWS-managed encryption
# until the follow-up commit wires `kms_key_id` / `kms_key_arn`
# inputs through them and the operator runs the re-encryption
# runbook (also a follow-up commit). Outputs from this module
# stand by unused after the first apply; that's intentional —
# it gives the operator a clean Terraform plan to review before
# any data moves.

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
# Common: caller identity + region (used by every key policy)
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name

  base_name = "${var.name_prefix}-${var.environment}"

  # Common tags applied to every key. The provider-level
  # `default_tags` block already supplies `Project` / `Environment`
  # / `ManagedBy`; this module adds the Phase identifier and the
  # service slug so a key-by-key audit query can pivot on it.
  base_tags = merge(
    {
      Phase     = "9"
      Component = "kms"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# Key-policy fragments
#
# Each key reuses the "account root can administer this key"
# statement; the data source below builds it once and the per-key
# policy documents below mix it with a service-specific use
# grant.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "admin_only" {
  # Account-root admin: the standard boilerplate every AWS-published
  # key-policy example starts with. Allows IAM policies in this
  # account to delegate fine-grained key permissions to specific
  # roles (without this, only the key policy itself can grant
  # access — locking-out risk).
  statement {
    sid    = "AllowAccountRootKeyAdmin"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }
}

# -----------------------------------------------------------------------------
# Per-service key policies
#
# Each policy document combines the admin statement above with a
# service-principal use grant. Where AWS supports it, the use
# grant is fenced behind a `kms:ViaService` condition so the
# permission only applies when the call comes through the named
# service (an STS-assumed role that's not coming through, say,
# RDS, still can't use the RDS key).
# -----------------------------------------------------------------------------

# --- RDS ---------------------------------------------------------------------

data "aws_iam_policy_document" "rds" {
  source_policy_documents = [data.aws_iam_policy_document.admin_only.json]

  statement {
    sid    = "AllowRDSUse"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
      # `CreateGrant` is what RDS calls when it spins up the
      # underlying storage volume — without this RDS can't
      # provision the instance against the CMK.
      "kms:CreateGrant",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["rds.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "rds" {
  description             = "EthioLink ${var.environment} — RDS Postgres storage + master-secret encryption."
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.rds.json

  tags = merge(local.base_tags, {
    Name    = "${local.base_name}-rds"
    Service = "rds"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "rds" {
  name          = "alias/${local.base_name}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

# --- S3 media ----------------------------------------------------------------

data "aws_iam_policy_document" "s3_media" {
  source_policy_documents = [data.aws_iam_policy_document.admin_only.json]

  statement {
    sid    = "AllowS3Use"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "s3_media" {
  description             = "EthioLink ${var.environment} — public + private media bucket encryption."
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.s3_media.json

  tags = merge(local.base_tags, {
    Name    = "${local.base_name}-s3-media"
    Service = "s3-media"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "s3_media" {
  name          = "alias/${local.base_name}-s3-media"
  target_key_id = aws_kms_key.s3_media.key_id
}

# --- S3 logs -----------------------------------------------------------------

# Kept separate from `s3_media`: an audit / log-analyzer role
# might legitimately get RW access to the logs key without
# needing access to the customer-facing media key. Two keys keep
# those grants distinct.

data "aws_iam_policy_document" "s3_logs" {
  source_policy_documents = [data.aws_iam_policy_document.admin_only.json]

  statement {
    sid    = "AllowS3Use"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

  # The S3 access-log delivery service writes log objects on
  # behalf of source buckets. When the destination bucket is
  # encrypted with a CMK, `logging.s3.amazonaws.com` needs to be
  # able to `GenerateDataKey` to write each log entry.
  statement {
    sid    = "AllowS3LoggingDelivery"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    actions = [
      "kms:GenerateDataKey*",
      "kms:Decrypt",
      "kms:DescribeKey",
    ]
    resources = ["*"]
  }
}

resource "aws_kms_key" "s3_logs" {
  description             = "EthioLink ${var.environment} — S3 server-access-logs bucket encryption."
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.s3_logs.json

  tags = merge(local.base_tags, {
    Name    = "${local.base_name}-s3-logs"
    Service = "s3-logs"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "s3_logs" {
  name          = "alias/${local.base_name}-s3-logs"
  target_key_id = aws_kms_key.s3_logs.key_id
}

# --- S3 admin frontend -------------------------------------------------------

data "aws_iam_policy_document" "s3_admin_frontend" {
  source_policy_documents = [data.aws_iam_policy_document.admin_only.json]

  statement {
    sid    = "AllowS3Use"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["s3.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${local.region}.amazonaws.com"]
    }
  }

  # CloudFront with OAC reads objects from the admin-frontend
  # bucket on behalf of the distribution's service principal.
  # When the bucket uses a CMK, CloudFront needs `kms:Decrypt`
  # on the key. The `aws:SourceArn` condition fences this to
  # the specific account; the per-distribution narrowing
  # happens through the bucket policy (already in place in the
  # admin-frontend module) — KMS only needs to allow the
  # CloudFront principal in this account.
  statement {
    sid    = "AllowCloudFrontOACDecrypt"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["kms:Decrypt"]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_kms_key" "s3_admin_frontend" {
  description             = "EthioLink ${var.environment} — admin SPA bucket encryption (CloudFront OAC reads)."
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.s3_admin_frontend.json

  tags = merge(local.base_tags, {
    Name    = "${local.base_name}-s3-admin-frontend"
    Service = "s3-admin-frontend"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "s3_admin_frontend" {
  name          = "alias/${local.base_name}-s3-admin-frontend"
  target_key_id = aws_kms_key.s3_admin_frontend.key_id
}

# --- Secrets Manager ---------------------------------------------------------

data "aws_iam_policy_document" "secrets" {
  source_policy_documents = [data.aws_iam_policy_document.admin_only.json]

  statement {
    sid    = "AllowSecretsManagerUse"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["secretsmanager.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "secrets" {
  description             = "EthioLink ${var.environment} — Secrets Manager encryption (RDS master, future third-party API keys)."
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.secrets.json

  tags = merge(local.base_tags, {
    Name    = "${local.base_name}-secrets"
    Service = "secrets"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.base_name}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}

# --- Lambda env vars ---------------------------------------------------------

data "aws_iam_policy_document" "lambda_env" {
  source_policy_documents = [data.aws_iam_policy_document.admin_only.json]

  statement {
    sid    = "AllowLambdaUse"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }

    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:DescribeKey",
    ]
    resources = ["*"]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["lambda.${local.region}.amazonaws.com"]
    }
  }
}

resource "aws_kms_key" "lambda_env" {
  description             = "EthioLink ${var.environment} — Lambda environment-variable encryption."
  key_usage               = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  enable_key_rotation     = var.enable_key_rotation
  deletion_window_in_days = var.deletion_window_in_days
  policy                  = data.aws_iam_policy_document.lambda_env.json

  tags = merge(local.base_tags, {
    Name    = "${local.base_name}-lambda-env"
    Service = "lambda-env"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "lambda_env" {
  name          = "alias/${local.base_name}-lambda-env"
  target_key_id = aws_kms_key.lambda_env.key_id
}
