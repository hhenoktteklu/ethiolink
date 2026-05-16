# EthioLink — admin frontend hosting module.
#
# Provisions:
#   * A private S3 bucket (`ethiolink-${env}-admin-frontend`) with
#     block-public-access fully on. The bucket is not reachable on
#     the internet — CloudFront's OAC is the only principal that
#     can read objects.
#   * A CloudFront Origin Access Control (the OAI successor —
#     sigv4-signed S3 requests instead of the deprecated OAI
#     pattern).
#   * A CloudFront distribution with two cache behaviors:
#       - Default: long-cache for hashed assets
#         (`max-age=31536000, immutable`).
#       - Ordered behavior for `/index.html`: no-cache so the
#         operator gets the latest bundle pointer on every refresh.
#     SPA fallback maps S3's 403 (object not found behind OAC)
#     and 404 to `/index.html` returning 200 — React Router
#     handles deep links from there.
#   * A bucket policy granting `s3:GetObject` to the CloudFront
#     service principal, scoped to the specific distribution ARN.
#   * One `aws_s3_object` per file under `var.admin_dist_path`,
#     with Cache-Control headers per file (no-cache on
#     `index.html`, long-cache everywhere else) and content-type
#     resolved from the extension.
#
# What it does NOT do:
#   * Build the SPA. The pre-build step (`cd admin && npm ci &&
#     npm run build`) is documented in the module header.
#   * Invalidate the CloudFront cache after upload. Operators run
#     `aws cloudfront create-invalidation --paths "/index.html"`
#     after a deploy; only `index.html` needs invalidation because
#     Vite hashes all other filenames.
#   * Provision the ACM cert. When `custom_domain` is set, the
#     consumer passes the ARN of a pre-existing us-east-1 cert.

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
  base_name   = "${var.name_prefix}-${var.environment}"
  bucket_name = "${local.base_name}-admin-frontend"
  oac_name    = "${local.base_name}-admin-oac"
  headers_policy_name = "${local.base_name}-admin-security-headers"

  has_custom_domain = var.custom_domain != "" && var.acm_certificate_arn != ""

  # -------------------------------------------------------------------------
  # Phase 8 — Content-Security-Policy.
  #
  # Built dynamically from the three origin-allowlist variables so that the
  # CSP shrinks to a sensible default in a half-wired environment (e.g. the
  # bootstrap apply before Cognito is up). The policy is the strict
  # whitelist posture documented in `docs/operations/SECURITY_REVIEW.md`:
  #
  #   * No `unsafe-inline` or `unsafe-eval` on `script-src` — the Vite
  #     production build emits hashed bundles only; nothing inline lives
  #     in the resulting `index.html` script tags (we verified by reading
  #     the build output).
  #   * `style-src` keeps `'unsafe-inline'` because Vite + Tailwind emit
  #     inline `<style>` runtime blocks (CSS injection during HMR is dev-
  #     only, but the production bundle still contains one inline style
  #     header for the splash-screen flash-of-unstyled-content guard).
  #     Hash-pinning the splash style is a follow-up; the in-bundle JS
  #     surface stays the high-value target.
  #   * `connect-src` lists the API + Cognito hosts so the SPA can call
  #     them via `fetch` — without these, every authenticated request is
  #     blocked by the browser's CSP enforcer.
  #   * `form-action` lists Cognito so the hosted-UI redirect succeeds.
  #   * `img-src` lists the public-media S3 bucket so business covers +
  #     staff avatars render. `data:` is allowed for the empty-state SVG
  #     thumbnails the SPA inlines.
  #   * `frame-ancestors 'none'` is the click-jacking guard (paired with
  #     X-Frame-Options DENY below — newer browsers honor `frame-ancestors`,
  #     older ones honor the header). The admin SPA is never embedded.
  #
  # When a downstream variable is empty (operator hasn't passed the
  # value yet), the corresponding fragment is dropped — the CSP is
  # always syntactically valid but functionally tighter.
  # -------------------------------------------------------------------------

  csp_connect_extra = compact([
    var.api_gateway_origin,
    var.cognito_origin,
  ])

  csp_form_action_extra = compact([
    var.cognito_origin,
  ])

  csp_img_extra = compact([
    var.media_public_origin,
  ])

  csp_script_extra = var.csp_extra_script_src

  content_security_policy = join("; ", [
    "default-src 'self'",
    "script-src 'self'${length(local.csp_script_extra) > 0 ? " ${join(" ", local.csp_script_extra)}" : ""}",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:${length(local.csp_img_extra) > 0 ? " ${join(" ", local.csp_img_extra)}" : ""}",
    "font-src 'self' data:",
    "connect-src 'self'${length(local.csp_connect_extra) > 0 ? " ${join(" ", local.csp_connect_extra)}" : ""}",
    "form-action 'self'${length(local.csp_form_action_extra) > 0 ? " ${join(" ", local.csp_form_action_extra)}" : ""}",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ])

  # Content-type lookup keyed by extension (lowercase, no leading
  # dot). Falls back to `application/octet-stream` for anything
  # not listed.
  content_types = {
    "html" = "text/html; charset=utf-8"
    "htm"  = "text/html; charset=utf-8"
    "js"   = "application/javascript; charset=utf-8"
    "mjs"  = "application/javascript; charset=utf-8"
    "css"  = "text/css; charset=utf-8"
    "json" = "application/json"
    "map"  = "application/json"
    "svg"  = "image/svg+xml"
    "png"  = "image/png"
    "jpg"  = "image/jpeg"
    "jpeg" = "image/jpeg"
    "webp" = "image/webp"
    "gif"  = "image/gif"
    "ico"  = "image/x-icon"
    "woff"  = "font/woff"
    "woff2" = "font/woff2"
    "ttf"   = "font/ttf"
    "txt"   = "text/plain; charset=utf-8"
  }

  common_tags = merge(
    {
      Component = "admin-frontend"
      Module    = "admin-frontend"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# S3 bucket — private, OAC-readable only.
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "this" {
  bucket        = local.bucket_name
  force_destroy = false

  tags = merge(local.common_tags, {
    Name = local.bucket_name
    Tier = "admin-frontend"
  })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  # Phase 9 Track 4 — SSE-S3 by default; SSE-KMS when the caller
  # passes `kms_key_arn`. CloudFront OAC reads are unaffected: the
  # `s3_admin_frontend` CMK policy allows the CloudFront service
  # principal `kms:Decrypt` with an `aws:SourceAccount` fence.
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == null ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != null
  }
}

resource "aws_s3_bucket_versioning" "this" {
  bucket = aws_s3_bucket.this.id

  # Off by default. Vite bundles use content-hashed filenames so
  # every deploy is effectively a new set of objects; versioning
  # would double storage cost without buying recoverability.
  versioning_configuration {
    status = "Suspended"
  }
}

# -----------------------------------------------------------------------------
# CloudFront — distribution + OAC.
# -----------------------------------------------------------------------------

# -----------------------------------------------------------------------------
# Phase 8 — CloudFront response headers policy.
#
# Attached below to both the default and `/index.html` cache behaviors.
# CloudFront injects these headers on every response, so they apply
# uniformly to the SPA shell, hashed asset bundles, and the SPA-fallback
# 200 responses generated by `custom_error_response` (the 403/404
# redirects to `/index.html`).
#
# Trade-off: the policy is attached to the distribution, not the bucket
# objects. If an operator ever serves the bucket directly (e.g. for a
# debug session), the headers won't be present — that's intentional, the
# bucket is private behind OAC so direct serving isn't a path.
# -----------------------------------------------------------------------------

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = local.headers_policy_name
  comment = "EthioLink ${var.environment} admin SPA security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy)."

  security_headers_config {
    # HSTS — one year, include subdomains, preload-eligible. Same
    # posture as the AWS-published baseline for production SPAs.
    # `override = true` ensures we win even if the origin sets a
    # weaker value.
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = true
      override                   = true
    }

    content_type_options {
      override = true
    }

    # Click-jacking guard. Paired with `frame-ancestors 'none'` in the
    # CSP above — modern browsers honor the CSP directive, older ones
    # honor the header.
    frame_options {
      frame_option = "DENY"
      override     = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    content_security_policy {
      content_security_policy = local.content_security_policy
      override                = true
    }
  }

  custom_headers_config {
    # Permissions-Policy isn't a first-class field on the AWS
    # `security_headers_config` block, so it ships as a custom
    # header. Disables the three high-risk powerful features the
    # admin SPA never needs (camera / microphone / geolocation).
    # If a future feature legitimately needs one of these, the list
    # is the right place to scope it.
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
      override = true
    }
  }
}

resource "aws_cloudfront_origin_access_control" "this" {
  name                              = local.oac_name
  description                       = "OAC for ${local.bucket_name}. Sigv4-signed S3 reads from the EthioLink ${var.environment} admin CloudFront distribution."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "this" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = "EthioLink ${var.environment} admin SPA distribution."
  default_root_object = "index.html"
  price_class         = var.price_class

  aliases = local.has_custom_domain ? [var.custom_domain] : []

  origin {
    domain_name              = aws_s3_bucket.this.bucket_regional_domain_name
    origin_id                = "s3-admin-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.this.id
  }

  # Default cache behavior — long-cache for hashed assets.
  default_cache_behavior {
    target_origin_id           = "s3-admin-frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    # 1 year cache, but the operator's deploy invalidates
    # `/index.html` directly; everything else is content-hashed
    # so the cache is automatically correct.
    min_ttl     = 0
    default_ttl = 31536000
    max_ttl     = 31536000

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  # Ordered behavior for `/index.html` — no caching at the edge.
  # `/index.html` is the one mutable file: it points at the
  # hash-named JS bundles, so a stale copy serves the wrong app
  # version.
  ordered_cache_behavior {
    path_pattern               = "/index.html"
    target_origin_id           = "s3-admin-frontend"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  # SPA fallback. React Router owns the `/businesses`,
  # `/users`, `/notifications`, etc. routes — they don't exist
  # as S3 objects. CloudFront receives a 404 (or 403 when the
  # OAC-signed request hits a missing key) and rewrites to
  # `/index.html` with a 200 status so the SPA boots and routes.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = local.has_custom_domain ? false : true
    acm_certificate_arn            = local.has_custom_domain ? var.acm_certificate_arn : null
    ssl_support_method             = local.has_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.has_custom_domain ? "TLSv1.2_2021" : "TLSv1"
  }

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-admin-cloudfront"
  })
}

# -----------------------------------------------------------------------------
# Bucket policy — grant CloudFront the S3 read.
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "bucket" {
  statement {
    sid    = "AllowCloudFrontOACRead"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.this.arn}/*"]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.this.arn]
    }
  }

  # Force-TLS on every bucket operation.
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    actions = ["s3:*"]

    resources = [
      aws_s3_bucket.this.arn,
      "${aws_s3_bucket.this.arn}/*",
    ]

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "this" {
  bucket = aws_s3_bucket.this.id
  policy = data.aws_iam_policy_document.bucket.json
}

# -----------------------------------------------------------------------------
# Upload — every file under `var.admin_dist_path` becomes an
# `aws_s3_object`. `etag = filemd5(...)` triggers a re-upload on
# content change; the operator runs a CloudFront invalidation
# afterwards (only `/index.html` matters — Vite-hashed asset
# filenames are immutable).
# -----------------------------------------------------------------------------

locals {
  asset_files = fileset(var.admin_dist_path, "**/*")
}

resource "aws_s3_object" "asset" {
  for_each = local.asset_files

  bucket = aws_s3_bucket.this.id
  key    = each.value
  source = "${var.admin_dist_path}/${each.value}"
  etag   = filemd5("${var.admin_dist_path}/${each.value}")

  content_type = lookup(
    local.content_types,
    lower(element(split(".", each.value), length(split(".", each.value)) - 1)),
    "application/octet-stream",
  )

  # `index.html` is the mutable pointer; everything else under
  # `/assets/` (Vite default) is content-hashed and immutable.
  cache_control = each.value == "index.html" ? "no-cache, no-store, must-revalidate" : "public, max-age=31536000, immutable"
}
