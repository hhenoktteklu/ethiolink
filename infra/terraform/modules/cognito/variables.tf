# EthioLink — Cognito module inputs.
#
# This module provisions a single Cognito user pool with three role groups
# (CUSTOMER, BUSINESS_OWNER, ADMIN) and two app clients (mobile + admin).
# Consumed by infra/terraform/environments/<env>/main.tf.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in resource names and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form names like \"ethiolink-dev-users\"."
  type        = string
  default     = "ethiolink"
}

variable "mobile_callback_urls" {
  description = "OAuth callback URLs for the mobile app client. Deep link scheme is used in production; localhost is allowed in dev."
  type        = list(string)
  default     = ["ethiolink://auth/callback"]
}

variable "mobile_logout_urls" {
  description = "OAuth logout URLs for the mobile app client."
  type        = list(string)
  default     = ["ethiolink://auth/logout"]
}

variable "admin_callback_urls" {
  description = "OAuth callback URLs for the admin dashboard. MUST end in `/login` — that's the SPA route (`admin/src/pages/LoginPage.tsx`) that handles the `?code=...` exchange. The dev environment passes the localhost URL; production passes the real domain. Mismatches surface as a Cognito hosted-UI 400 (`redirect_mismatch`) when the SPA tries to sign in."
  type        = list(string)
  default     = ["http://localhost:5173/login"]
}

variable "admin_logout_urls" {
  description = "OAuth logout URLs for the admin dashboard. The SPA navigates here after Cognito's `/logout` endpoint clears the session — typically the same `/login` route so the operator lands on a fresh sign-in page."
  type        = list(string)
  default     = ["http://localhost:5173/login"]
}

variable "password_minimum_length" {
  description = "Minimum password length enforced by Cognito. Default 12 — the Phase 8 security-review-pass default. Combined with the module's `require_symbols = true` in main.tf, the resulting policy is: minimum 12 chars + at least one lowercase + one uppercase + one digit + one symbol. Existing users with shorter passwords keep their current credentials until the next password change."
  type        = number
  default     = 12

  validation {
    condition     = var.password_minimum_length >= 8 && var.password_minimum_length <= 99
    error_message = "password_minimum_length must be between 8 and 99 (Cognito limits)."
  }
}

variable "access_token_validity_minutes" {
  description = "Lifetime of access tokens issued by Cognito, in minutes."
  type        = number
  default     = 60
}

variable "id_token_validity_minutes" {
  description = "Lifetime of ID tokens issued by Cognito, in minutes."
  type        = number
  default     = 60
}

variable "refresh_token_validity_days" {
  description = "Lifetime of refresh tokens issued by Cognito, in days."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Additional tags applied to all resources created by this module."
  type        = map(string)
  default     = {}
}
