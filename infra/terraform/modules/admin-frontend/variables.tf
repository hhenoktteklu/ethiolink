# EthioLink — admin frontend hosting module inputs.
#
# Hosts the React admin SPA (`admin/dist/`) from a private S3
# bucket behind a CloudFront distribution. The bucket is not
# directly reachable on the internet — CloudFront's Origin Access
# Control (OAC, the successor to the older Origin Access Identity)
# is the only principal allowed to read objects.
#
# The build artifact MUST exist before `terraform apply` — the
# `fileset(...)` over `var.admin_dist_path` reads the directory at
# plan time, and a missing path fails the plan with a clear error.
# The pre-build step is:
#
#     cd admin
#     npm ci
#     # Configure VITE_* env vars per environment first.
#     npm run build   # emits admin/dist/
#
# Then `terraform apply` uploads every file under `admin/dist/` as
# `aws_s3_object` resources keyed by file path; on subsequent
# applies, the `etag = filemd5(...)` causes only changed objects
# to re-upload. CloudFront caches the old version until its TTL
# expires; the operator runs an invalidation manually:
#
#     aws cloudfront create-invalidation \
#         --distribution-id <distribution_id> \
#         --paths "/index.html"
#
# (Only `index.html` needs invalidation because the rest of the
# bundle uses Vite's content-hashed filenames.)

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in resource names + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form the bucket name (`ethiolink-${var.environment}-admin-frontend`)."
  type        = string
  default     = "ethiolink"
}

variable "admin_dist_path" {
  description = "Absolute path to the pre-built admin SPA directory (typically `<repo-root>/admin/dist`). Operators must run `npm ci && npm run build` under `admin/` before `terraform apply` — the module reads the directory at plan time."
  type        = string
}

variable "custom_domain" {
  description = "Optional custom domain name for the distribution (e.g. `admin.ethiolink.app`). When empty (the dev default), CloudFront serves the SPA from its built-in `<id>.cloudfront.net` hostname. When set, `acm_certificate_arn` MUST also be set — CloudFront requires the cert before it accepts an alias."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "Optional ARN of an ACM certificate covering `custom_domain`. MUST be in `us-east-1` regardless of the application's primary region — that's a hard CloudFront constraint. Ignored when `custom_domain` is empty."
  type        = string
  default     = ""
}

variable "price_class" {
  description = "CloudFront price class. `PriceClass_100` covers North America + Europe edges (cheapest), `PriceClass_200` adds Asia + South America. For Ethiopian customers, `PriceClass_200` is closer (Cape Town edge); MVP defaults to `_100` because admin traffic is a few operators."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be one of: PriceClass_100, PriceClass_200, PriceClass_All."
  }
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}
