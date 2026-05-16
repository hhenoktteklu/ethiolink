# EthioLink — S3 module inputs.
#
# Provisions three buckets per environment:
#
#   * `ethiolink-${environment}-media-public`  — publicly readable
#     business / staff / customer media (cover photos, gallery,
#     avatars). The mobile and admin apps fetch these via direct
#     S3 URLs; a future CloudFront distribution may sit in front.
#   * `ethiolink-${environment}-media-private` — private uploads
#     (KYC documents, future invoice PDFs, anything that must not
#     be world-readable). Served via presigned GETs from a future
#     download endpoint.
#   * `ethiolink-${environment}-logs`          — server access
#     logging target for both media buckets, plus a stash slot for
#     any future audit logs we want outside CloudWatch.
#
# `S3StorageGateway` (`backend/shared/adapters/storage/`) is the
# sole writer for media-public and media-private; it picks the
# bucket from `IssueUploadUrlInput.isPublic`. The gateway uses
# `PutObjectCommand` without an explicit ACL, so the public-read
# semantics live on the bucket policy below (object-level ACLs
# are disabled by `Object Ownership = BucketOwnerEnforced`).

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in bucket names and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Bucket name prefix. Combined with environment + suffix to form S3-global-unique bucket names like `ethiolink-dev-media-public`. Defaults to \"ethiolink\"."
  type        = string
  default     = "ethiolink"
}

variable "admin_allowed_origins" {
  description = "Browser origins allowed by the media buckets' CORS policy when the admin dashboard fetches public assets or PUTs to a private presigned URL. Example: `[\"http://localhost:5173\", \"https://admin.ethiolink.app\"]`. Empty list = no CORS configuration block created."
  type        = list(string)
  default     = []
}

variable "mobile_allowed_origins" {
  description = "Browser origins allowed by the media buckets' CORS policy when a mobile web shell (future) fetches assets. Native iOS / Android HTTP clients do NOT enforce CORS, so the default empty list is correct until a real mobile-web surface ships. Set to `[\"*\"]` only if a forward-compat web shell needs it."
  type        = list(string)
  default     = []
}

variable "enable_public_bucket_versioning" {
  description = "Enable versioning on the public media bucket. Default `false` — public assets (business cover photos, staff avatars) are easily replaceable from the source upload UX, and versioning doubles storage cost. Prod overrides to `true` if a real audit-replay need surfaces."
  type        = bool
  default     = false
}

variable "logs_expiration_days" {
  description = "Lifecycle rule that expires objects in the logs bucket after N days. Default `90` (dev posture: short retention, low cost); prod typically overrides to `365`. Set to `0` to disable expiration entirely (only do this if a downstream archive process is configured to vacuum the bucket out-of-band)."
  type        = number
  default     = 90

  validation {
    condition     = var.logs_expiration_days >= 0
    error_message = "logs_expiration_days must be 0 (disabled) or positive."
  }
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module. Merged with the per-resource Component / Module tags."
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Phase 9 Track 4 — KMS inputs.
#
# Per-bucket nullable CMK ARNs. `null` (the default) keeps the
# existing SSE-S3 (`AES256`) encryption — no behavior change. When
# set, the bucket's default SSE flips to `aws:kms` with
# `kms_master_key_id = <arn>` and `bucket_key_enabled = true`.
# The bucket-key flag amortizes per-object KMS calls into one
# key-rotation-cycle GenerateDataKey per ~5 minutes per bucket,
# which keeps SSE-KMS cost from blowing up under media-heavy
# workloads.
#
# **Existing objects are NOT re-encrypted by this change.** S3
# applies the new default to subsequent writes only; the re-
# encryption runbook (`aws s3 cp s3://b s3://b --recursive
# --metadata-directive REPLACE --sse aws:kms --sse-kms-key-id
# <arn>`) is the supported migration path for objects already in
# the bucket.
# -----------------------------------------------------------------------------

variable "media_kms_key_arn" {
  description = "ARN of the customer-managed KMS key used to encrypt the public + private media buckets. `null` (the default) preserves SSE-S3 (`AES256`); a non-null value flips both media buckets to SSE-KMS with `bucket_key_enabled = true`. Existing objects keep their previous encryption until the re-encryption runbook re-puts them."
  type        = string
  default     = null
}

variable "logs_kms_key_arn" {
  description = "ARN of the customer-managed KMS key used to encrypt the server-access-logs bucket. Kept separate from `media_kms_key_arn` so an audit-side log-reader grant doesn't widen access to customer-facing media. `null` (the default) preserves SSE-S3."
  type        = string
  default     = null
}
