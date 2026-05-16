# EthioLink — REST API Gateway module.
#
# Provisions one REST API per environment with 48 HTTP routes
# (every Lambda handler under `backend/lambdas/` except
# `scheduled/sendReminders` which is EventBridge-triggered). The
# REST flavor is chosen over HTTP API for two reasons:
#
#   1. Per-method Cognito user-pool authorizer is a first-class
#      REST surface; HTTP API requires a JWT authorizer with
#      slightly different claim-extraction semantics.
#   2. The OpenAPI doc already targets REST; matching it 1:1 makes
#      a future "import OpenAPI directly" follow-up trivial.
#
# Route list (the authoritative source — see `locals.routes`):
#
#   Public (no authorizer):
#     GET    /v1/categories
#     GET    /v1/businesses
#     GET    /v1/businesses/{businessId}
#     GET    /v1/businesses/{businessId}/services
#     GET    /v1/businesses/{businessId}/staff
#     GET    /v1/businesses/{businessId}/staff/{staffId}/availability
#     GET    /v1/businesses/{businessId}/staff/{staffId}/slots
#     GET    /v1/businesses/{businessId}/reviews
#
#   Authenticated (Cognito user-pool):
#     POST   /v1/auth/sync
#     GET    /v1/me
#     PATCH  /v1/me
#     GET    /v1/me/business
#     GET    /v1/me/appointments
#     POST   /v1/businesses
#     PATCH  /v1/businesses/{businessId}
#     POST   /v1/businesses/{businessId}/submit
#     POST   /v1/businesses/{businessId}/services
#     PATCH  /v1/businesses/{businessId}/services/{id}
#     DELETE /v1/businesses/{businessId}/services/{id}
#     POST   /v1/businesses/{businessId}/staff
#     PATCH  /v1/businesses/{businessId}/staff/{id}
#     DELETE /v1/businesses/{businessId}/staff/{id}
#     PUT    /v1/businesses/{businessId}/staff/{staffId}/availability
#     POST   /v1/businesses/{businessId}/staff/{staffId}/availability/override
#     GET    /v1/businesses/{businessId}/appointments
#     POST   /v1/media/upload-url
#     POST   /v1/media
#     POST   /v1/appointments
#     POST   /v1/appointments/{id}/accept
#     POST   /v1/appointments/{id}/reject
#     POST   /v1/appointments/{id}/cancel
#     POST   /v1/appointments/{id}/reschedule
#     POST   /v1/appointments/{id}/complete
#     POST   /v1/appointments/{id}/review
#     GET    /v1/admin/businesses
#     POST   /v1/admin/businesses/{id}/approve
#     POST   /v1/admin/businesses/{id}/reject
#     POST   /v1/admin/businesses/{id}/suspend
#     POST   /v1/admin/businesses/{id}/feature
#     GET    /v1/admin/users
#     POST   /v1/admin/users/{id}/suspend
#     POST   /v1/admin/users/{id}/restore
#     GET    /v1/admin/categories
#     POST   /v1/admin/categories
#     PATCH  /v1/admin/categories/{id}
#     DELETE /v1/admin/categories/{id}
#     GET    /v1/admin/appointments
#     GET    /v1/admin/notifications
#
# Path-variable name conflict: the position `/v1/businesses/{X}/...`
# is shared by the public single-entity GET and the nested
# (services, staff, appointments) parents. API Gateway requires
# ONE variable name per segment, so we use `{businessId}` for
# every URL at that position. Handler code that previously read
# `event.pathParameters.id` for the business id was normalized to
# read `.businessId` in the same commit. The `{id}` name is kept
# only at the children of services / staff / appointments where
# it doesn't conflict.
#
# CORS:
#   * Every resource that has at least one non-OPTIONS method
#     also has an OPTIONS method using a mock integration that
#     emits the standard `Access-Control-Allow-*` headers.
#   * `aws_api_gateway_gateway_response.default_4xx` /
#     `default_5xx` add the same headers to error responses so
#     the admin SPA can see the upstream error code rather than
#     a CORS-mangled "fetch failed".

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
  api_name  = "${local.base_name}-api"

  common_tags = merge(
    {
      Component = "api-gateway"
      Module    = "api-gateway"
    },
    var.tags,
  )

  cors_origin_header = join(",", var.cors_allowed_origins)

  # -------------------------------------------------------------------------
  # Resource tree — flat list of every URL path segment.
  # `parent` is the parent segment's path; empty string = API root.
  # -------------------------------------------------------------------------
  resource_paths = [
    { path = "v1", parent = "" },
    { path = "v1/auth", parent = "v1" },
    { path = "v1/auth/sync", parent = "v1/auth" },
    { path = "v1/me", parent = "v1" },
    { path = "v1/me/business", parent = "v1/me" },
    { path = "v1/me/appointments", parent = "v1/me" },
    { path = "v1/me/link-telegram", parent = "v1/me" },
    { path = "v1/me/link-telegram/start", parent = "v1/me/link-telegram" },
    { path = "v1/me/telegram-status", parent = "v1/me" },
    { path = "v1/integrations", parent = "v1" },
    { path = "v1/integrations/telegram", parent = "v1/integrations" },
    { path = "v1/integrations/telegram/webhook", parent = "v1/integrations/telegram" },
    # Phase 10 commit 3 — Chapa webhook landing path.
    { path = "v1/integrations/chapa", parent = "v1/integrations" },
    { path = "v1/integrations/chapa/webhook", parent = "v1/integrations/chapa" },
    { path = "v1/categories", parent = "v1" },
    { path = "v1/businesses", parent = "v1" },
    { path = "v1/businesses/{businessId}", parent = "v1/businesses" },
    { path = "v1/businesses/{businessId}/submit", parent = "v1/businesses/{businessId}" },
    { path = "v1/businesses/{businessId}/reviews", parent = "v1/businesses/{businessId}" },
    { path = "v1/businesses/{businessId}/services", parent = "v1/businesses/{businessId}" },
    { path = "v1/businesses/{businessId}/services/{id}", parent = "v1/businesses/{businessId}/services" },
    { path = "v1/businesses/{businessId}/staff", parent = "v1/businesses/{businessId}" },
    { path = "v1/businesses/{businessId}/staff/{id}", parent = "v1/businesses/{businessId}/staff" },
    # `{staffId}` and `{id}` at the same position collide; the
    # services/staff-detail patch / delete use `{id}`, but the
    # availability + slots sub-tree uses `{staffId}` per the
    # OpenAPI spec + the existing handler code. We keep `{id}`
    # at the staff-detail position and route the availability
    # sub-tree under a duplicate `{staffId}` variable to match
    # handler reads. API Gateway's path matching is positional;
    # the variable names are independent across non-overlapping
    # parents.
    { path = "v1/businesses/{businessId}/staff/{staffId}", parent = "v1/businesses/{businessId}/staff" },
    { path = "v1/businesses/{businessId}/staff/{staffId}/availability", parent = "v1/businesses/{businessId}/staff/{staffId}" },
    { path = "v1/businesses/{businessId}/staff/{staffId}/availability/override", parent = "v1/businesses/{businessId}/staff/{staffId}/availability" },
    { path = "v1/businesses/{businessId}/staff/{staffId}/slots", parent = "v1/businesses/{businessId}/staff/{staffId}" },
    { path = "v1/businesses/{businessId}/appointments", parent = "v1/businesses/{businessId}" },
    # Phase 9 Track 6 — paid featuring sub-tree.
    { path = "v1/businesses/{businessId}/featuring", parent = "v1/businesses/{businessId}" },
    { path = "v1/businesses/{businessId}/featuring/packages", parent = "v1/businesses/{businessId}/featuring" },
    { path = "v1/businesses/{businessId}/featuring/subscribe", parent = "v1/businesses/{businessId}/featuring" },
    { path = "v1/businesses/{businessId}/featuring/active", parent = "v1/businesses/{businessId}/featuring" },
    { path = "v1/businesses/{businessId}/featuring/history", parent = "v1/businesses/{businessId}/featuring" },
    { path = "v1/media", parent = "v1" },
    { path = "v1/media/upload-url", parent = "v1/media" },
    { path = "v1/appointments", parent = "v1" },
    { path = "v1/appointments/{id}", parent = "v1/appointments" },
    { path = "v1/appointments/{id}/accept", parent = "v1/appointments/{id}" },
    { path = "v1/appointments/{id}/reject", parent = "v1/appointments/{id}" },
    { path = "v1/appointments/{id}/cancel", parent = "v1/appointments/{id}" },
    { path = "v1/appointments/{id}/reschedule", parent = "v1/appointments/{id}" },
    { path = "v1/appointments/{id}/complete", parent = "v1/appointments/{id}" },
    { path = "v1/appointments/{id}/review", parent = "v1/appointments/{id}" },
    { path = "v1/admin", parent = "v1" },
    { path = "v1/admin/businesses", parent = "v1/admin" },
    { path = "v1/admin/businesses/{id}", parent = "v1/admin/businesses" },
    { path = "v1/admin/businesses/{id}/approve", parent = "v1/admin/businesses/{id}" },
    { path = "v1/admin/businesses/{id}/reject", parent = "v1/admin/businesses/{id}" },
    { path = "v1/admin/businesses/{id}/suspend", parent = "v1/admin/businesses/{id}" },
    { path = "v1/admin/businesses/{id}/feature", parent = "v1/admin/businesses/{id}" },
    # Phase 9 Track 6 — admin-side paid featuring sub-tree.
    { path = "v1/admin/businesses/{id}/featuring", parent = "v1/admin/businesses/{id}" },
    { path = "v1/admin/businesses/{id}/featuring/history", parent = "v1/admin/businesses/{id}/featuring" },
    { path = "v1/admin/businesses/{id}/featuring/comp", parent = "v1/admin/businesses/{id}/featuring" },
    { path = "v1/admin/businesses/{id}/featuring/cancel", parent = "v1/admin/businesses/{id}/featuring" },
    { path = "v1/admin/users", parent = "v1/admin" },
    { path = "v1/admin/users/{id}", parent = "v1/admin/users" },
    { path = "v1/admin/users/{id}/suspend", parent = "v1/admin/users/{id}" },
    { path = "v1/admin/users/{id}/restore", parent = "v1/admin/users/{id}" },
    { path = "v1/admin/categories", parent = "v1/admin" },
    { path = "v1/admin/categories/{id}", parent = "v1/admin/categories" },
    { path = "v1/admin/appointments", parent = "v1/admin" },
    { path = "v1/admin/notifications", parent = "v1/admin" },
  ]

  resource_paths_map = { for r in local.resource_paths : r.path => r }

  # -------------------------------------------------------------------------
  # Routes — one entry per (method × path × handler) tuple.
  # `auth` is either "PUBLIC" (no authorizer) or "COGNITO".
  # -------------------------------------------------------------------------
  routes = {
    # Public routes -------------------------------------------------------
    "GET_v1_categories" = {
      path = "v1/categories", method = "GET", function = "categories-list", auth = "PUBLIC"
    }
    "GET_v1_businesses" = {
      path = "v1/businesses", method = "GET", function = "businesses-list", auth = "PUBLIC"
    }
    "GET_v1_businesses_id" = {
      path = "v1/businesses/{businessId}", method = "GET", function = "businesses-get", auth = "PUBLIC"
    }
    "GET_v1_businesses_id_reviews" = {
      path = "v1/businesses/{businessId}/reviews", method = "GET", function = "reviews-list-for-business", auth = "PUBLIC"
    }
    "GET_v1_businesses_id_services" = {
      path = "v1/businesses/{businessId}/services", method = "GET", function = "services-list", auth = "PUBLIC"
    }
    "GET_v1_businesses_id_staff" = {
      path = "v1/businesses/{businessId}/staff", method = "GET", function = "staff-list", auth = "PUBLIC"
    }
    "GET_v1_businesses_id_staff_id_availability" = {
      path = "v1/businesses/{businessId}/staff/{staffId}/availability", method = "GET", function = "availability-get", auth = "PUBLIC"
    }
    "GET_v1_businesses_id_staff_id_slots" = {
      path = "v1/businesses/{businessId}/staff/{staffId}/slots", method = "GET", function = "availability-slots", auth = "PUBLIC"
    }

    # Authenticated routes ------------------------------------------------
    "POST_v1_auth_sync" = {
      path = "v1/auth/sync", method = "POST", function = "auth-sync", auth = "COGNITO"
    }
    "GET_v1_me" = {
      path = "v1/me", method = "GET", function = "me-get", auth = "COGNITO"
    }
    "PATCH_v1_me" = {
      path = "v1/me", method = "PATCH", function = "me-patch", auth = "COGNITO"
    }
    "GET_v1_me_business" = {
      path = "v1/me/business", method = "GET", function = "businesses-me", auth = "COGNITO"
    }
    "GET_v1_me_appointments" = {
      path = "v1/me/appointments", method = "GET", function = "appointments-list-mine", auth = "COGNITO"
    }
    "POST_v1_me_link_telegram_start" = {
      path = "v1/me/link-telegram/start", method = "POST", function = "me-link-telegram-start", auth = "COGNITO"
    }
    "GET_v1_me_telegram_status" = {
      path = "v1/me/telegram-status", method = "GET", function = "me-link-telegram-status", auth = "COGNITO"
    }
    "DELETE_v1_me_link_telegram" = {
      path = "v1/me/link-telegram", method = "DELETE", function = "me-link-telegram-unlink", auth = "COGNITO"
    }
    "POST_v1_integrations_telegram_webhook" = {
      # Public route — Telegram POSTs from its own infrastructure
      # with no client-side auth. The Lambda checks
      # `X-Telegram-Bot-Api-Secret-Token` against the configured
      # webhook secret and rejects mismatches with 401. Authorization
      # is therefore handled application-side, not at API Gateway.
      path = "v1/integrations/telegram/webhook", method = "POST", function = "integrations-telegram-webhook", auth = "PUBLIC"
    }
    "POST_v1_integrations_chapa_webhook" = {
      # Phase 10 commit 3 — public route Chapa POSTs to after a
      # customer completes hosted checkout. Authentication is via
      # the `Chapa-Signature` HMAC-SHA256 header validated by the
      # Lambda against `config.chapaProvider.webhookSecret`;
      # mismatches return 401. Same posture as the Telegram
      # webhook above — application-side auth, not API GW-side.
      path = "v1/integrations/chapa/webhook", method = "POST", function = "integrations-chapa-webhook", auth = "PUBLIC"
    }
    "POST_v1_businesses" = {
      path = "v1/businesses", method = "POST", function = "businesses-create", auth = "COGNITO"
    }
    "PATCH_v1_businesses_id" = {
      path = "v1/businesses/{businessId}", method = "PATCH", function = "businesses-patch", auth = "COGNITO"
    }
    "POST_v1_businesses_id_submit" = {
      path = "v1/businesses/{businessId}/submit", method = "POST", function = "businesses-submit", auth = "COGNITO"
    }
    "POST_v1_businesses_id_services" = {
      path = "v1/businesses/{businessId}/services", method = "POST", function = "services-create", auth = "COGNITO"
    }
    "PATCH_v1_businesses_id_services_id" = {
      path = "v1/businesses/{businessId}/services/{id}", method = "PATCH", function = "services-patch", auth = "COGNITO"
    }
    "DELETE_v1_businesses_id_services_id" = {
      path = "v1/businesses/{businessId}/services/{id}", method = "DELETE", function = "services-delete", auth = "COGNITO"
    }
    "POST_v1_businesses_id_staff" = {
      path = "v1/businesses/{businessId}/staff", method = "POST", function = "staff-create", auth = "COGNITO"
    }
    "PATCH_v1_businesses_id_staff_id" = {
      path = "v1/businesses/{businessId}/staff/{id}", method = "PATCH", function = "staff-patch", auth = "COGNITO"
    }
    "DELETE_v1_businesses_id_staff_id" = {
      path = "v1/businesses/{businessId}/staff/{id}", method = "DELETE", function = "staff-delete", auth = "COGNITO"
    }
    "PUT_v1_businesses_id_staff_id_availability" = {
      path = "v1/businesses/{businessId}/staff/{staffId}/availability", method = "PUT", function = "availability-replace", auth = "COGNITO"
    }
    "POST_v1_businesses_id_staff_id_availability_override" = {
      path = "v1/businesses/{businessId}/staff/{staffId}/availability/override", method = "POST", function = "availability-add-override", auth = "COGNITO"
    }
    "GET_v1_businesses_id_appointments" = {
      path = "v1/businesses/{businessId}/appointments", method = "GET", function = "appointments-list-for-business", auth = "COGNITO"
    }
    # Phase 9 Track 6 — paid featuring owner-side routes.
    "GET_v1_businesses_id_featuring_packages" = {
      path = "v1/businesses/{businessId}/featuring/packages", method = "GET", function = "featuring-list-packages", auth = "COGNITO"
    }
    "POST_v1_businesses_id_featuring_subscribe" = {
      path = "v1/businesses/{businessId}/featuring/subscribe", method = "POST", function = "featuring-subscribe", auth = "COGNITO"
    }
    "GET_v1_businesses_id_featuring_active" = {
      path = "v1/businesses/{businessId}/featuring/active", method = "GET", function = "featuring-get-active", auth = "COGNITO"
    }
    "GET_v1_businesses_id_featuring_history" = {
      path = "v1/businesses/{businessId}/featuring/history", method = "GET", function = "featuring-list-history", auth = "COGNITO"
    }
    "POST_v1_media_upload_url" = {
      path = "v1/media/upload-url", method = "POST", function = "media-upload-url", auth = "COGNITO"
    }
    "POST_v1_media" = {
      path = "v1/media", method = "POST", function = "media-confirm", auth = "COGNITO"
    }
    "POST_v1_appointments" = {
      path = "v1/appointments", method = "POST", function = "appointments-create", auth = "COGNITO"
    }
    "POST_v1_appointments_id_accept" = {
      path = "v1/appointments/{id}/accept", method = "POST", function = "appointments-accept", auth = "COGNITO"
    }
    "POST_v1_appointments_id_reject" = {
      path = "v1/appointments/{id}/reject", method = "POST", function = "appointments-reject", auth = "COGNITO"
    }
    "POST_v1_appointments_id_cancel" = {
      path = "v1/appointments/{id}/cancel", method = "POST", function = "appointments-cancel", auth = "COGNITO"
    }
    "POST_v1_appointments_id_reschedule" = {
      path = "v1/appointments/{id}/reschedule", method = "POST", function = "appointments-reschedule", auth = "COGNITO"
    }
    "POST_v1_appointments_id_complete" = {
      path = "v1/appointments/{id}/complete", method = "POST", function = "appointments-complete", auth = "COGNITO"
    }
    "POST_v1_appointments_id_review" = {
      path = "v1/appointments/{id}/review", method = "POST", function = "appointments-review", auth = "COGNITO"
    }

    # Admin routes (ADMIN role enforced application-side) -----------------
    "GET_v1_admin_businesses" = {
      path = "v1/admin/businesses", method = "GET", function = "admin-businesses-list", auth = "COGNITO"
    }
    "POST_v1_admin_businesses_id_approve" = {
      path = "v1/admin/businesses/{id}/approve", method = "POST", function = "admin-businesses-approve", auth = "COGNITO"
    }
    "POST_v1_admin_businesses_id_reject" = {
      path = "v1/admin/businesses/{id}/reject", method = "POST", function = "admin-businesses-reject", auth = "COGNITO"
    }
    "POST_v1_admin_businesses_id_suspend" = {
      path = "v1/admin/businesses/{id}/suspend", method = "POST", function = "admin-businesses-suspend", auth = "COGNITO"
    }
    "POST_v1_admin_businesses_id_feature" = {
      path = "v1/admin/businesses/{id}/feature", method = "POST", function = "admin-businesses-feature", auth = "COGNITO"
    }
    # Phase 9 Track 6 — admin-side paid featuring routes.
    "GET_v1_admin_businesses_id_featuring_history" = {
      path = "v1/admin/businesses/{id}/featuring/history", method = "GET", function = "admin-featuring-list-history", auth = "COGNITO"
    }
    "POST_v1_admin_businesses_id_featuring_comp" = {
      path = "v1/admin/businesses/{id}/featuring/comp", method = "POST", function = "admin-featuring-comp", auth = "COGNITO"
    }
    "POST_v1_admin_businesses_id_featuring_cancel" = {
      path = "v1/admin/businesses/{id}/featuring/cancel", method = "POST", function = "admin-featuring-cancel", auth = "COGNITO"
    }
    "GET_v1_admin_users" = {
      path = "v1/admin/users", method = "GET", function = "admin-users-list", auth = "COGNITO"
    }
    "POST_v1_admin_users_id_suspend" = {
      path = "v1/admin/users/{id}/suspend", method = "POST", function = "admin-users-suspend", auth = "COGNITO"
    }
    "POST_v1_admin_users_id_restore" = {
      path = "v1/admin/users/{id}/restore", method = "POST", function = "admin-users-restore", auth = "COGNITO"
    }
    "GET_v1_admin_categories" = {
      path = "v1/admin/categories", method = "GET", function = "admin-categories-list", auth = "COGNITO"
    }
    "POST_v1_admin_categories" = {
      path = "v1/admin/categories", method = "POST", function = "admin-categories-create", auth = "COGNITO"
    }
    "PATCH_v1_admin_categories_id" = {
      path = "v1/admin/categories/{id}", method = "PATCH", function = "admin-categories-patch", auth = "COGNITO"
    }
    "DELETE_v1_admin_categories_id" = {
      path = "v1/admin/categories/{id}", method = "DELETE", function = "admin-categories-delete", auth = "COGNITO"
    }
    "GET_v1_admin_appointments" = {
      path = "v1/admin/appointments", method = "GET", function = "admin-appointments-list", auth = "COGNITO"
    }
    "GET_v1_admin_notifications" = {
      path = "v1/admin/notifications", method = "GET", function = "admin-notifications-list", auth = "COGNITO"
    }
  }

  # Set of resource paths that have at least one non-OPTIONS
  # method — every one needs an OPTIONS preflight method.
  resource_paths_with_method = toset([for r in local.routes : r.path])
}

# -----------------------------------------------------------------------------
# REST API + authorizer
# -----------------------------------------------------------------------------

resource "aws_api_gateway_rest_api" "this" {
  name        = local.api_name
  description = "EthioLink ${var.environment} REST API. Cognito-authorized; 8 public read endpoints documented in `AWS_DEPLOYMENT.md`."

  endpoint_configuration {
    types = ["REGIONAL"]
  }

  tags = local.common_tags
}

resource "aws_api_gateway_authorizer" "cognito" {
  name            = "${local.base_name}-cognito"
  rest_api_id     = aws_api_gateway_rest_api.this.id
  type            = "COGNITO_USER_POOLS"
  provider_arns   = [var.cognito_user_pool_arn]
  identity_source = "method.request.header.Authorization"
}

# -----------------------------------------------------------------------------
# Resources — one per unique path segment.
# -----------------------------------------------------------------------------

resource "aws_api_gateway_resource" "this" {
  for_each = local.resource_paths_map

  rest_api_id = aws_api_gateway_rest_api.this.id
  parent_id = each.value.parent == "" ? aws_api_gateway_rest_api.this.root_resource_id : aws_api_gateway_resource.this[each.value.parent].id
  path_part = element(split("/", each.value.path), length(split("/", each.value.path)) - 1)
}

# -----------------------------------------------------------------------------
# Methods, integrations, and Lambda permissions — one per route.
# -----------------------------------------------------------------------------

resource "aws_api_gateway_method" "this" {
  for_each = local.routes

  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.this[each.value.path].id
  http_method   = each.value.method
  authorization = each.value.auth == "PUBLIC" ? "NONE" : "COGNITO_USER_POOLS"
  authorizer_id = each.value.auth == "PUBLIC" ? null : aws_api_gateway_authorizer.cognito.id
}

resource "aws_api_gateway_integration" "this" {
  for_each = local.routes

  rest_api_id             = aws_api_gateway_rest_api.this.id
  resource_id             = aws_api_gateway_resource.this[each.value.path].id
  http_method             = aws_api_gateway_method.this[each.key].http_method
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = var.lambda_function_invoke_arns[each.value.function]
}

resource "aws_lambda_permission" "this" {
  for_each = local.routes

  # statement_id must match [a-zA-Z0-9-]; convert the route key.
  statement_id  = "AllowAPIGatewayInvoke-${replace(replace(replace(each.key, "_", "-"), "/", "-"), ".", "-")}"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_function_names[each.value.function]
  principal     = "apigateway.amazonaws.com"

  # Scoped to this specific method on this specific resource — a
  # `/*/*` wildcard would let any future route on the same API
  # invoke the function without an explicit permission grant.
  source_arn = "${aws_api_gateway_rest_api.this.execution_arn}/*/${each.value.method}/${each.value.path}"
}

# -----------------------------------------------------------------------------
# CORS — OPTIONS preflight per resource with at least one method.
# -----------------------------------------------------------------------------

resource "aws_api_gateway_method" "options" {
  for_each = local.resource_paths_with_method

  rest_api_id   = aws_api_gateway_rest_api.this.id
  resource_id   = aws_api_gateway_resource.this[each.value].id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "options" {
  for_each = local.resource_paths_with_method

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.value].id
  http_method = aws_api_gateway_method.options[each.value].http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "options" {
  for_each = local.resource_paths_with_method

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.value].id
  http_method = aws_api_gateway_method.options[each.value].http_method
  status_code = "204"

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true
    "method.response.header.Access-Control-Allow-Methods" = true
    "method.response.header.Access-Control-Allow-Origin"  = true
    "method.response.header.Access-Control-Max-Age"       = true
  }
}

resource "aws_api_gateway_integration_response" "options" {
  for_each = local.resource_paths_with_method

  rest_api_id = aws_api_gateway_rest_api.this.id
  resource_id = aws_api_gateway_resource.this[each.value].id
  http_method = aws_api_gateway_method.options[each.value].http_method
  status_code = aws_api_gateway_method_response.options[each.value].status_code

  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Authorization,Content-Type,X-Amz-Date,X-Amz-Security-Token,X-Api-Key'"
    "method.response.header.Access-Control-Allow-Methods" = "'GET,POST,PUT,PATCH,DELETE,OPTIONS'"
    "method.response.header.Access-Control-Allow-Origin"  = "'${local.cors_origin_header}'"
    "method.response.header.Access-Control-Max-Age"       = "'3600'"
  }

  depends_on = [aws_api_gateway_integration.options]
}

# -----------------------------------------------------------------------------
# Gateway responses — inject CORS headers on 4xx / 5xx so the
# admin SPA can see the upstream error code rather than a CORS-
# mangled "fetch failed".
# -----------------------------------------------------------------------------

resource "aws_api_gateway_gateway_response" "default_4xx" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "DEFAULT_4XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${local.cors_origin_header}'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Authorization,Content-Type'"
  }
}

resource "aws_api_gateway_gateway_response" "default_5xx" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  response_type = "DEFAULT_5XX"

  response_parameters = {
    "gatewayresponse.header.Access-Control-Allow-Origin"  = "'${local.cors_origin_header}'"
    "gatewayresponse.header.Access-Control-Allow-Headers" = "'Authorization,Content-Type'"
  }
}

# -----------------------------------------------------------------------------
# Deployment + stage.
#
# The deployment is regenerated whenever the route map, resource
# map, or authorizer changes — `triggers` carries a hash of every
# upstream input. Stage name is the environment name so the
# invoke URL is predictable (`/dev`, `/prod`).
# -----------------------------------------------------------------------------

resource "aws_api_gateway_deployment" "this" {
  rest_api_id = aws_api_gateway_rest_api.this.id

  triggers = {
    redeploy = sha1(jsonencode({
      routes      = local.routes
      paths       = local.resource_paths
      cors        = local.cors_origin_header
      authorizer  = aws_api_gateway_authorizer.cognito.id
    }))
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [
    aws_api_gateway_method.this,
    aws_api_gateway_integration.this,
    aws_api_gateway_method.options,
    aws_api_gateway_integration.options,
    aws_api_gateway_method_response.options,
    aws_api_gateway_integration_response.options,
    aws_api_gateway_gateway_response.default_4xx,
    aws_api_gateway_gateway_response.default_5xx,
  ]
}

resource "aws_api_gateway_stage" "this" {
  rest_api_id   = aws_api_gateway_rest_api.this.id
  deployment_id = aws_api_gateway_deployment.this.id
  stage_name    = var.environment

  tags = local.common_tags
}
