# EthioLink — Cognito module.
#
# Provisions:
#   - One Cognito user pool (email and phone sign-in).
#   - Three Cognito groups: CUSTOMER, BUSINESS_OWNER, ADMIN.
#   - Two app clients: "mobile" (Flutter, PKCE public client) and "admin"
#     (React dashboard, confidential client).
#
# Notes:
#   - prevent_destroy is set on the user pool. Recreating a pool invalidates
#     every issued JWT and every user record, so we never want Terraform to
#     destroy it as a side effect.
#   - MFA is configured as OPTIONAL per MVP scope (Phase 1 does not enforce MFA).
#   - Social providers are intentionally absent for MVP (see ADR-0002).

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
  base_name = "${var.name_prefix}-${var.environment}"

  common_tags = merge(
    {
      Component = "cognito"
      Module    = "cognito"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# User pool
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool" "this" {
  name = "${local.base_name}-users"

  # Allow sign-in with either email or phone. username_attributes controls
  # which attributes can be used as the login identifier.
  username_attributes      = ["email", "phone_number"]
  auto_verified_attributes = ["email"]

  mfa_configuration = "OPTIONAL"

  software_token_mfa_configuration {
    enabled = true
  }

  # Phase 8 password policy: 12-char minimum + symbol required.
  # Previous Phase 1 defaults (10 / no-symbol) were the
  # operator-friendly bootstrap stance; the tighter posture is
  # the production-ready default that the security-review pass
  # adopts. Existing users with passwords that satisfy only the
  # old policy continue to authenticate — Cognito enforces the
  # new policy on next password change, not retroactively.
  password_policy {
    minimum_length                   = var.password_minimum_length
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
    recovery_mechanism {
      name     = "verified_phone_number"
      priority = 2
    }
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  schema {
    name                     = "email"
    attribute_data_type      = "String"
    required                 = false
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  schema {
    name                     = "phone_number"
    attribute_data_type      = "String"
    required                 = false
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 1
      max_length = 32
    }
  }

  schema {
    name                     = "name"
    attribute_data_type      = "String"
    required                 = false
    mutable                  = true
    developer_only_attribute = false
    string_attribute_constraints {
      min_length = 1
      max_length = 256
    }
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["email"]
  }

  tags = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# Groups — one per application role.
#
# Lower precedence wins when a user is in multiple groups; we order so that
# ADMIN beats BUSINESS_OWNER beats CUSTOMER. The backend reads the user's
# Cognito groups on /v1/auth/sync and maps the highest-priority group to the
# user's role in the users table.
# -----------------------------------------------------------------------------

resource "aws_cognito_user_group" "customer" {
  name         = "CUSTOMER"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "End-customer role. Default for self-service signups."
  precedence   = 30
}

resource "aws_cognito_user_group" "business_owner" {
  name         = "BUSINESS_OWNER"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "Business owner role. Granted after a business profile is approved."
  precedence   = 20
}

resource "aws_cognito_user_group" "admin" {
  name         = "ADMIN"
  user_pool_id = aws_cognito_user_pool.this.id
  description  = "EthioLink staff with access to the admin dashboard."
  precedence   = 10
}

# -----------------------------------------------------------------------------
# App client — mobile (Flutter customer + business)
#
# Public client, PKCE flow, no client secret. Used by the Flutter app.
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "mobile" {
  name         = "${local.base_name}-mobile"
  user_pool_id = aws_cognito_user_pool.this.id

  generate_secret = false

  # USER_SRP_AUTH for password sign-in; REFRESH for token renewal.
  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  supported_identity_providers = ["COGNITO"]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "phone", "profile"]

  callback_urls = var.mobile_callback_urls
  logout_urls   = var.mobile_logout_urls

  access_token_validity  = var.access_token_validity_minutes
  id_token_validity      = var.id_token_validity_minutes
  refresh_token_validity = var.refresh_token_validity_days

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  read_attributes = [
    "email",
    "email_verified",
    "phone_number",
    "phone_number_verified",
    "name",
  ]

  write_attributes = [
    "email",
    "phone_number",
    "name",
  ]
}

# -----------------------------------------------------------------------------
# App client — admin dashboard (React)
#
# Public PKCE client. The React SPA at `admin/src/lib/auth.ts` runs
# the authorization-code-with-PKCE flow directly from the browser —
# no backend code exchange and therefore no place to keep a client
# secret. `generate_secret = false` is the correct posture for any
# in-browser OAuth client (a secret embedded in a JS bundle is just
# a public string).
#
# The callback URL on the SPA side is `/login?code=...` (the
# `LoginPage` component handles the exchange). The Cognito client
# MUST list the same URL in its `callback_urls`, otherwise the
# hosted-UI redirect is rejected. Each environment passes its own
# concrete URL through `var.admin_callback_urls` (dev:
# `http://localhost:5173/login`; prod:
# `https://admin.ethiolink.app/login`).
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool_client" "admin" {
  name         = "${local.base_name}-admin"
  user_pool_id = aws_cognito_user_pool.this.id

  # Public PKCE client — no secret. Flipping this on an existing
  # client requires Terraform to *replace* the resource (Cognito
  # treats `generate_secret` as immutable). The replacement issues
  # a new client id, which means the admin SPA's
  # `VITE_COGNITO_ADMIN_CLIENT_ID` must be re-read from the
  # Terraform output after the apply. Same posture as the mobile
  # client, which has always been public.
  generate_secret = false

  explicit_auth_flows = [
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_REFRESH_TOKEN_AUTH",
  ]

  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  supported_identity_providers = ["COGNITO"]

  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  callback_urls = var.admin_callback_urls
  logout_urls   = var.admin_logout_urls

  access_token_validity  = var.access_token_validity_minutes
  id_token_validity      = var.id_token_validity_minutes
  refresh_token_validity = var.refresh_token_validity_days

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }

  read_attributes = [
    "email",
    "email_verified",
    "name",
  ]

  write_attributes = [
    "email",
    "name",
  ]
}

# -----------------------------------------------------------------------------
# Hosted UI domain
#
# Each environment gets its own subdomain on the shared *.auth.<region>.amazoncognito.com
# zone. Domain prefixes are globally unique; we scope by environment.
# -----------------------------------------------------------------------------

resource "aws_cognito_user_pool_domain" "this" {
  domain       = local.base_name
  user_pool_id = aws_cognito_user_pool.this.id
}
