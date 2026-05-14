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
  description = "OAuth callback URLs for the admin dashboard. The dev environment includes localhost; production should pass the real domain."
  type        = list(string)
  default     = ["http://localhost:5173/auth/callback"]
}

variable "admin_logout_urls" {
  description = "OAuth logout URLs for the admin dashboard."
  type        = list(string)
  default     = ["http://localhost:5173/auth/logout"]
}

variable "password_minimum_length" {
  description = "Minimum password length enforced by Cognito."
  type        = number
  default     = 10
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
