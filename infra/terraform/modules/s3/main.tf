# EthioLink — S3 module.
#
# Three buckets per environment with the shared posture documented
# inline below. Naming follows the S3-global pattern
# `<prefix>-<environment>-<suffix>` so a single AWS account can
# host dev + prod side by side without name collisions.
#
# Object ownership:
#   Every bucket sets `Object Ownership = BucketOwnerEnforced`,
#   which disables ACLs. Access control happens entirely via the
#   bucket policies + IAM. This is AWS's current recommended
#   default and survives the 2023 ACL-related security default
#   changes.
#
# Encryption:
#   `AES256` SSE-S3 on every bucket. KMS is a Phase 8 hardening
#   step — the keys, key policies, and key rotation lifecycle are
#   non-trivial and don't move the MVP forward today.
#
# Server access logging:
#   The two media buckets log to the logs bucket under per-bucket
#   prefixes so admins can grep by source bucket. The logs bucket
#   intentionally has no access-log target — recursive logging is
#   a footgun without lifecycle expiration tight enough to bound
#   it.
#
# Force-destroy:
#   `force_destroy = false` on all three buckets, plus
#   `prevent_destroy = true` on the lifecycle blocks. The combo
#   means even a `terraform destroy` cannot tear down a bucket
#   that has any content — accidental loss of customer media is
#   the worst-case outcome for this module, so the protection is
#   belt-and-braces.
#
# VPC endpoints:
#   Not created here. Lambdas reach S3 over the public AWS
#   endpoint via the NAT today. A `gateway` VPC endpoint to
#   `com.amazonaws.<region>.s3` is the cheap follow-up once a
#   real workload measures the NAT egress cost. Adding it later
#   is a Lambda-side route-table change — no S3 module churn.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

data "aws_partition" "current" {}

locals {
  base_name = "${var.name_prefix}-${var.environment}"

  bucket_media_public  = "${local.base_name}-media-public"
  bucket_media_private = "${local.base_name}-media-private"
  bucket_logs          = "${local.base_name}-logs"

  cors_origins = distinct(concat(var.admin_allowed_origins, var.mobile_allowed_origins))

  common_tags = merge(
    {
      Component = "s3"
      Module    = "s3"
    },
    var.tags,
  )
}

# =============================================================================
# Logs bucket — defined first; the media buckets reference it as
# their server-access-log target.
# =============================================================================

resource "aws_s3_bucket" "logs" {
  bucket        = local.bucket_logs
  force_destroy = false

  tags = merge(local.common_tags, {
    Name = local.bucket_logs
    Tier = "logs"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "logs" {
  bucket = aws_s3_bucket.logs.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "logs" {
  bucket = aws_s3_bucket.logs.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Required for S3 server-access logging to write into this bucket.
# `logging.s3.amazonaws.com` is the service principal AWS uses for
# the logging delivery; restrict the source ARNs to the two media
# buckets in this same module so a stray logger from another
# account can't dump objects here.
data "aws_iam_policy_document" "logs_bucket" {
  # Allow the S3 service to write access logs from the media
  # buckets in this stack.
  statement {
    sid    = "AllowS3LoggingDelivery"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }

    actions = ["s3:PutObject"]

    resources = [
      "${aws_s3_bucket.logs.arn}/media-public/*",
      "${aws_s3_bucket.logs.arn}/media-private/*",
    ]

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"

      values = [
        aws_s3_bucket.media_public.arn,
        aws_s3_bucket.media_private.arn,
      ]
    }
  }

  # Force-TLS on every operation against the logs bucket.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.logs.arn,
      "${aws_s3_bucket.logs.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "logs" {
  bucket = aws_s3_bucket.logs.id
  policy = data.aws_iam_policy_document.logs_bucket.json
}

# Lifecycle expiration. `logs_expiration_days = 0` disables.
resource "aws_s3_bucket_lifecycle_configuration" "logs" {
  count = var.logs_expiration_days > 0 ? 1 : 0

  bucket = aws_s3_bucket.logs.id

  rule {
    id     = "expire-old-logs"
    status = "Enabled"

    filter {}

    expiration {
      days = var.logs_expiration_days
    }

    # Versioning is intentionally not enabled on the logs bucket
    # (logs are append-only by nature); the noncurrent-version
    # rules below are no-ops today but become protection if
    # versioning is ever turned on later.
    noncurrent_version_expiration {
      noncurrent_days = max(var.logs_expiration_days, 1)
    }
  }
}

# =============================================================================
# Public media bucket — publicly readable via bucket policy.
# =============================================================================

resource "aws_s3_bucket" "media_public" {
  bucket        = local.bucket_media_public
  force_destroy = false

  tags = merge(local.common_tags, {
    Name = local.bucket_media_public
    Tier = "media-public"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "media_public" {
  bucket = aws_s3_bucket.media_public.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Public bucket needs `block_public_policy = false` so we can
# attach the read-allow policy below. The other three flags stay
# on — ACLs are disabled (BucketOwnerEnforced) and we don't want
# any future ACL-based public grants slipping through.
resource "aws_s3_bucket_public_access_block" "media_public" {
  bucket = aws_s3_bucket.media_public.id

  block_public_acls       = true
  block_public_policy     = false
  ignore_public_acls      = true
  restrict_public_buckets = false
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media_public" {
  bucket = aws_s3_bucket.media_public.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "media_public" {
  bucket = aws_s3_bucket.media_public.id

  versioning_configuration {
    status = var.enable_public_bucket_versioning ? "Enabled" : "Suspended"
  }
}

data "aws_iam_policy_document" "media_public" {
  # Public GET on every object. The TLS deny statement below
  # forces clients to use HTTPS; combined with the AWS Managed
  # Rules WAF (Phase 7 waf module), this is the standard "public
  # read, secure transport" pattern.
  statement {
    sid    = "PublicReadGetObject"
    effect = "Allow"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media_public.arn}/*"]
  }

  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.media_public.arn,
      "${aws_s3_bucket.media_public.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media_public" {
  bucket = aws_s3_bucket.media_public.id
  policy = data.aws_iam_policy_document.media_public.json

  # The policy depends on `block_public_policy = false`, which is
  # set above. AWS rejects the PutBucketPolicy call before the
  # public-access-block is updated; explicit depends_on makes the
  # ordering survive `terraform refresh`.
  depends_on = [aws_s3_bucket_public_access_block.media_public]
}

resource "aws_s3_bucket_cors_configuration" "media_public" {
  count = length(local.cors_origins) > 0 ? 1 : 0

  bucket = aws_s3_bucket.media_public.id

  cors_rule {
    allowed_methods = ["GET", "HEAD"]
    allowed_origins = local.cors_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_logging" "media_public" {
  bucket = aws_s3_bucket.media_public.id

  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "media-public/"

  # Wait for the logs bucket policy to grant the logging service
  # principal write access — without it, S3 silently drops every
  # log object.
  depends_on = [aws_s3_bucket_policy.logs]
}

# =============================================================================
# Private media bucket — fully blocked from public read.
# =============================================================================

resource "aws_s3_bucket" "media_private" {
  bucket        = local.bucket_media_private
  force_destroy = false

  tags = merge(local.common_tags, {
    Name = local.bucket_media_private
    Tier = "media-private"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "media_private" {
  bucket = aws_s3_bucket.media_private.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

# Fully blocked. Reads happen via presigned GETs only; the
# `S3StorageGateway` issues presigned URLs and the future
# download endpoint signs GETs against this bucket.
resource "aws_s3_bucket_public_access_block" "media_private" {
  bucket = aws_s3_bucket.media_private.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media_private" {
  bucket = aws_s3_bucket.media_private.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Versioning is ON for the private bucket: accidental object
# deletes can be recovered, and a future audit-replay path can
# walk historical versions of a sensitive upload.
resource "aws_s3_bucket_versioning" "media_private" {
  bucket = aws_s3_bucket.media_private.id

  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_iam_policy_document" "media_private" {
  # Force-TLS only. No public-read grant — IAM (the Lambda
  # execution role) is the only allowed reader / writer.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.media_private.arn,
      "${aws_s3_bucket.media_private.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "media_private" {
  bucket = aws_s3_bucket.media_private.id
  policy = data.aws_iam_policy_document.media_private.json
}

# CORS for the private bucket — needed so a browser-side PUT
# against a presigned URL succeeds (the SPA preflight asks the
# bucket). Both media buckets share the same allowed-origin
# list; methods diverge (private accepts PUT, public is
# read-only).
resource "aws_s3_bucket_cors_configuration" "media_private" {
  count = length(local.cors_origins) > 0 ? 1 : 0

  bucket = aws_s3_bucket.media_private.id

  cors_rule {
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = local.cors_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

resource "aws_s3_bucket_logging" "media_private" {
  bucket = aws_s3_bucket.media_private.id

  target_bucket = aws_s3_bucket.logs.id
  target_prefix = "media-private/"

  depends_on = [aws_s3_bucket_policy.logs]
}
