# EthioLink — CloudWatch monitoring module.
#
# Wires every Phase 7 module's operational signals into:
#
#   * One SNS topic per env (`ethiolink-${env}-alarms`) with an
#     optional email subscription. Empty `alarm_email` skips the
#     subscription — useful for the initial bootstrap apply
#     when no operator address is finalized.
#   * Seven alarms — one per critical signal — posting to the
#     SNS topic on breach. Every threshold is variabled so a
#     real on-call event can tune without a module change.
#   * Four dashboards (API Gateway / Lambda / RDS / WAF +
#     EventBridge) with the metric widgets the operator opens
#     first when investigating an incident.
#
# Why one aggregate Lambda alarm instead of 49 per-function:
#   49 per-function alarms cost ~$5/env/month (AWS WAFv2 + alarm
#   pricing) and produce 49 separate notifications when a
#   shared dependency (RDS connection exhaustion, Cognito
#   outage) fails everything. An aggregate alarm catches the
#   "something is wrong" signal at low cost; the Lambda
#   dashboard's per-function widgets are the drilldown. Per-
#   function alarms on a handful of critical handlers are a
#   Phase 8 follow-up once we know which ones matter most.

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
  topic_name  = "${local.base_name}-alarms"

  common_tags = merge(
    {
      Component = "cloudwatch"
      Module    = "cloudwatch"
    },
    var.tags,
  )

  # ---------------------------------------------------------------------------
  # Phase 8 — route-family partitioning.
  #
  # The Lambda module's `function_names` map is keyed by
  # `<area>-<file>` (e.g. `appointments-create`,
  # `admin-businesses-approve`). The four route families below
  # carry the operator's primary mental model when reading
  # latency / error dashboards: "is browsing slow", "is booking
  # broken", "are admin tools healthy", "is auth-sync misbehaving".
  #
  # Keys are explicit (not derived by prefix scan) so a new
  # handler doesn't silently slip into the wrong dashboard
  # category. Adding a handler is a one-line edit here, which
  # is the same edit the lambda module needs anyway.
  #
  # `try(...)` wraps every lookup so a missing key (e.g. the
  # handler was renamed in the lambda module but not here) is a
  # plan-time skip rather than a hard error. The `compact()` on
  # the metrics array drops any nulls before the dashboard JSON
  # is emitted.
  # ---------------------------------------------------------------------------

  browse_function_keys = [
    "categories-list",
    "businesses-list",
    "businesses-get",
    "reviews-list-for-business",
    "services-list",
    "staff-list",
    "availability-get",
    "availability-slots",
  ]

  appointment_function_keys = [
    "appointments-create",
    "appointments-accept",
    "appointments-reject",
    "appointments-cancel",
    "appointments-reschedule",
    "appointments-complete",
    "appointments-review",
    "appointments-list-mine",
    "appointments-list-for-business",
  ]

  # Admin function keys — derived by prefix because the admin
  # surface grows linearly with new admin features. Keying on
  # `startswith` keeps the dashboard self-updating when a new
  # admin handler lands without an edit here.
  admin_function_keys = sort([
    for k in keys(var.lambda_function_names) :
    k if startswith(k, "admin-")
  ])

  auth_sync_function_keys = [
    "auth-sync",
    "me-get",
    "me-patch",
  ]

  # Resolved (key → function name) maps after the `try` lookup,
  # filtered down to keys that actually exist in the lambda
  # module's output. Each dashboard widget consumes the matching
  # `_resolved` map.
  browse_functions = {
    for k in local.browse_function_keys :
    k => var.lambda_function_names[k] if contains(keys(var.lambda_function_names), k)
  }

  appointment_functions = {
    for k in local.appointment_function_keys :
    k => var.lambda_function_names[k] if contains(keys(var.lambda_function_names), k)
  }

  admin_functions = {
    for k in local.admin_function_keys :
    k => var.lambda_function_names[k]
  }

  auth_sync_functions = {
    for k in local.auth_sync_function_keys :
    k => var.lambda_function_names[k] if contains(keys(var.lambda_function_names), k)
  }

  # Single function lookup for the two SLO-burn alarms. The
  # alarm resources are gated on the key existing — a renamed
  # handler skips the alarm rather than blocking the apply.
  appointments_create_function = try(var.lambda_function_names["appointments-create"], null)
  businesses_list_function     = try(var.lambda_function_names["businesses-list"], null)
}

# -----------------------------------------------------------------------------
# SNS topic + optional email subscription.
# -----------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name         = local.topic_name
  display_name = "EthioLink ${var.environment} alarms"

  tags = merge(local.common_tags, {
    Name = local.topic_name
  })
}

resource "aws_sns_topic_subscription" "email" {
  count = var.alarm_email != "" ? 1 : 0

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email

  # The operator MUST click the confirmation link AWS emails to
  # this address. Until then, the subscription stays in
  # `PendingConfirmation` and no alarms reach the inbox.
}

# -----------------------------------------------------------------------------
# Alarms
# -----------------------------------------------------------------------------

# 1. API Gateway 5XX errors.
resource "aws_cloudwatch_metric_alarm" "api_gateway_5xx" {
  alarm_name          = "${local.base_name}-api-5xx"
  alarm_description   = "API Gateway 5xx errors over 5 minutes exceed ${var.api_gateway_5xx_threshold}. Check the Lambda errors alarm + the API Gateway dashboard to identify the failing route."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "5XXError"
  namespace           = "AWS/ApiGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = var.api_gateway_5xx_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    ApiName = "${local.base_name}-api"
    Stage   = var.api_gateway_stage_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# 2. Lambda errors (aggregate, namespace-wide for the account).
#    Drilldown lives on the Lambda dashboard's per-function widgets.
resource "aws_cloudwatch_metric_alarm" "lambda_errors" {
  alarm_name          = "${local.base_name}-lambda-errors"
  alarm_description   = "Total Lambda errors over 5 minutes exceed ${var.lambda_errors_threshold}. Open the Lambda dashboard to identify which function is failing."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = var.lambda_errors_threshold
  treat_missing_data  = "notBreaching"

  # No FunctionName dimension — catches every Lambda in the
  # account. Acceptable for MVP (only EthioLink Lambdas exist).
  # Per-function alarms on the booking-critical handlers are a
  # Phase 8 follow-up.

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# 3. RDS CPU.
resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.base_name}-rds-cpu"
  alarm_description   = "RDS CPU > ${var.rds_cpu_threshold_percent}% sustained for 10 minutes. Usually the precursor to connection exhaustion."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.rds_cpu_threshold_percent
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_identifier
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# 4. RDS open connections.
resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "${local.base_name}-rds-connections"
  alarm_description   = "RDS open connections >= ${var.rds_connections_threshold}. Approaching Postgres `max_connections`; check Lambda warm-pool sizing + RDS Proxy connection pooling."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 2
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Average"
  threshold           = var.rds_connections_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_identifier
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# 5. RDS free storage.
resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${local.base_name}-rds-free-storage"
  alarm_description   = "RDS free storage below ${var.rds_free_storage_threshold_bytes} bytes. Storage autoscaling should already be growing the volume — this alarm is the fallback when autoscaling lags."
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "FreeStorageSpace"
  namespace           = "AWS/RDS"
  period              = 300
  statistic           = "Minimum"
  threshold           = var.rds_free_storage_threshold_bytes
  treat_missing_data  = "notBreaching"

  dimensions = {
    DBInstanceIdentifier = var.rds_instance_identifier
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# 6. EventBridge FailedInvocations on the reminder rule.
resource "aws_cloudwatch_metric_alarm" "eventbridge_failed_invocations" {
  alarm_name          = "${local.base_name}-eventbridge-failed"
  alarm_description   = "EventBridge `FailedInvocations` >= ${var.eventbridge_failed_invocations_threshold} on the reminder rule over 5 minutes. The Lambda may be failing to reach RDS, or the IAM permission may have drifted."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "FailedInvocations"
  namespace           = "AWS/Events"
  period              = 300
  statistic           = "Sum"
  threshold           = var.eventbridge_failed_invocations_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    RuleName = var.eventbridge_rule_name
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# 7. WAF blocked requests (early-warning signal).
resource "aws_cloudwatch_metric_alarm" "waf_blocked_requests" {
  alarm_name          = "${local.base_name}-waf-blocked"
  alarm_description   = "WAF blocked-request count over 5 minutes exceeds ${var.waf_blocked_requests_threshold}. Either a real attack (the rules are working — investigate via `aws wafv2 get-sampled-requests`) or a managed-rule false-positive (toggle the corresponding `enable_*` knob)."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = var.waf_blocked_requests_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    WebACL = var.waf_web_acl_name
    Region = var.region
    Rule   = "ALL"
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Phase 8 — SLO-burn alarms.
#
# Two simple per-function alarms that act as fast-burn proxies
# for the SLOs defined in `docs/operations/SLOs.md`:
#
#   * `${env}-slo-booking-creation-errors` — fires when the
#     `appointments-create` Lambda's error count breaches the
#     threshold. The 30-day booking-creation SLO is 99.5%, but
#     a 30-day rolling number is a poor real-time signal — a
#     short-window error count catches an outage well before
#     the budget is in danger.
#
#   * `${env}-slo-browse-latency-p95` — fires when the
#     `businesses-list` Lambda's p95 duration breaches the SLO
#     target (800 ms). `businesses-list` is the heaviest browse
#     endpoint — if it breaches, the lighter reads almost
#     certainly do too.
#
# Both alarms are gated on the corresponding function key
# existing in the lambda module output. A renamed handler
# skips the alarm rather than blocking the apply; the dashboard
# widgets still render via the `try()` fallback in the locals
# block above.
# -----------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "slo_booking_creation_errors" {
  count = local.appointments_create_function != null ? 1 : 0

  alarm_name          = "${local.base_name}-slo-booking-creation-errors"
  alarm_description   = "SLO fast-burn: `appointments-create` Lambda errors >= ${var.slo_booking_creation_errors_threshold} over 5 minutes. The 30-day booking-creation SLO target is 99.5% — see `docs/operations/SLOs.md`. This alarm is a fast-burn proxy; the long-window number is the post-hoc reckoning."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = var.slo_booking_creation_errors_threshold
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = local.appointments_create_function
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.common_tags, {
    SLO = "booking-creation"
  })
}

resource "aws_cloudwatch_metric_alarm" "slo_browse_latency_p95" {
  count = local.businesses_list_function != null ? 1 : 0

  alarm_name          = "${local.base_name}-slo-browse-latency-p95"
  alarm_description   = "SLO fast-burn: `businesses-list` Lambda p95 duration > ${var.slo_browse_latency_p95_ms} ms for 2 consecutive 5-min windows. The rolling-7-day browse-latency SLO target is p95 < 800 ms — see `docs/operations/SLOs.md`."
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Duration"
  namespace           = "AWS/Lambda"
  period              = 300
  extended_statistic  = "p95"
  threshold           = var.slo_browse_latency_p95_ms
  treat_missing_data  = "notBreaching"

  dimensions = {
    FunctionName = local.businesses_list_function
  }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = merge(local.common_tags, {
    SLO = "browse-latency"
  })
}

# -----------------------------------------------------------------------------
# Dashboards
# -----------------------------------------------------------------------------

# API Gateway — request volume + 4xx/5xx + p95 latency.
resource "aws_cloudwatch_dashboard" "api_gateway" {
  dashboard_name = "${local.base_name}-api-gateway"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway request volume + errors"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/ApiGateway", "Count", "ApiName", "${local.base_name}-api", "Stage", var.api_gateway_stage_name],
            [".", "4XXError", ".", ".", ".", "."],
            [".", "5XXError", ".", ".", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "API Gateway latency (p50 / p95)"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/ApiGateway", "Latency", "ApiName", "${local.base_name}-api", "Stage", var.api_gateway_stage_name, { stat = "p50" }],
            ["...", { stat = "p95" }],
          ]
        }
      },
    ]
  })
}

# Lambda — per-function error + duration widgets.
resource "aws_cloudwatch_dashboard" "lambda" {
  dashboard_name = "${local.base_name}-lambda"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 24
        height = 6
        properties = {
          title  = "Lambda errors (all functions, summed)"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/Lambda", "Errors", { label = "Total errors" }],
            [".", "Invocations", { label = "Total invocations" }],
            [".", "Throttles", { label = "Throttles" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 24
        height = 8
        properties = {
          title  = "Per-function error counts"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in var.lambda_function_names :
            ["AWS/Lambda", "Errors", "FunctionName", name, { label = key }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 14
        width  = 24
        height = 8
        properties = {
          title  = "Per-function p95 duration (ms)"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in var.lambda_function_names :
            ["AWS/Lambda", "Duration", "FunctionName", name, { stat = "p95", label = key }]
          ]
        }
      },
    ]
  })
}

# RDS — CPU + connections + free storage + IOPS.
resource "aws_cloudwatch_dashboard" "rds" {
  dashboard_name = "${local.base_name}-rds"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "RDS CPU + connections"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_instance_identifier, { stat = "Average", yAxis = "left" }],
            [".", "DatabaseConnections", ".", ".", { stat = "Average", yAxis = "right" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "RDS free storage (bytes)"
          region = var.region
          stat   = "Minimum"
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", var.rds_instance_identifier],
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 24
        height = 6
        properties = {
          title  = "RDS read / write IOPS + latency"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/RDS", "ReadIOPS", "DBInstanceIdentifier", var.rds_instance_identifier],
            [".", "WriteIOPS", ".", "."],
            [".", "ReadLatency", ".", ".", { yAxis = "right" }],
            [".", "WriteLatency", ".", ".", { yAxis = "right" }],
          ]
        }
      },
    ]
  })
}

# Endpoints — per-route-family error + p95-latency widgets.
#
# Phase 8 addition. Four row-pairs, one per route family
# defined in the `local.*_functions` maps. Each pair renders
# errors (Sum, p300) on the left and p95 Lambda duration (ms)
# on the right. The dashboard maps cleanly onto the SLOs:
#
#   * Browse row → browse-latency SLO (target p95 < 800 ms).
#   * Appointments row → booking-creation SLO (target ≥ 99.5%).
#   * Admin row → "is the operator surface healthy".
#   * Auth-sync row → "is new-user onboarding broken".
#
# Each row is gated on its function map being non-empty —
# Terraform's `length(map) > 0` doesn't work directly inside a
# JSON literal, so we just emit the metric arrays and let the
# dashboard render an empty widget if the map is empty (no
# functions matched). That's a deliberate no-op: easier to
# debug an empty widget than an error.
resource "aws_cloudwatch_dashboard" "endpoints" {
  dashboard_name = "${local.base_name}-endpoints"

  dashboard_body = jsonencode({
    widgets = [
      # ---- Browse row -----------------------------------------------------
      {
        type   = "text"
        x      = 0
        y      = 0
        width  = 24
        height = 1
        properties = {
          markdown = "## Browse endpoints — SLO target p95 < 800 ms (rolling 7 days). See `docs/operations/SLOs.md` §2."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 1
        width  = 12
        height = 6
        properties = {
          title  = "Browse — errors (Sum)"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in local.browse_functions :
            ["AWS/Lambda", "Errors", "FunctionName", name, { label = key }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 1
        width  = 12
        height = 6
        properties = {
          title  = "Browse — Lambda duration p95 (ms)"
          region = var.region
          period = 300
          view   = "timeSeries"
          yAxis = {
            left = {
              label     = "ms"
              min       = 0
              showUnits = false
            }
          }
          metrics = [
            for key, name in local.browse_functions :
            ["AWS/Lambda", "Duration", "FunctionName", name, { stat = "p95", label = key }]
          ]
          annotations = {
            horizontal = [
              {
                value = var.slo_browse_latency_p95_ms
                label = "p95 SLO target"
                color = "#d62728"
              },
            ]
          }
        }
      },

      # ---- Appointments row -----------------------------------------------
      {
        type   = "text"
        x      = 0
        y      = 7
        width  = 24
        height = 1
        properties = {
          markdown = "## Appointments — SLO target ≥ 99.5% availability on `appointments-create` (rolling 30 days). See `docs/operations/SLOs.md` §1."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 8
        width  = 12
        height = 6
        properties = {
          title  = "Appointments — errors (Sum)"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in local.appointment_functions :
            ["AWS/Lambda", "Errors", "FunctionName", name, { label = key }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 8
        width  = 12
        height = 6
        properties = {
          title  = "Appointments — Lambda duration p95 (ms)"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in local.appointment_functions :
            ["AWS/Lambda", "Duration", "FunctionName", name, { stat = "p95", label = key }]
          ]
        }
      },

      # ---- Admin row ------------------------------------------------------
      {
        type   = "text"
        x      = 0
        y      = 14
        width  = 24
        height = 1
        properties = {
          markdown = "## Admin endpoints — no formal SLO. Watch for sustained error rates as a precursor signal."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 15
        width  = 12
        height = 6
        properties = {
          title  = "Admin — errors (Sum)"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in local.admin_functions :
            ["AWS/Lambda", "Errors", "FunctionName", name, { label = key }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 15
        width  = 12
        height = 6
        properties = {
          title  = "Admin — Lambda duration p95 (ms)"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in local.admin_functions :
            ["AWS/Lambda", "Duration", "FunctionName", name, { stat = "p95", label = key }]
          ]
        }
      },

      # ---- Auth-sync row --------------------------------------------------
      {
        type   = "text"
        x      = 0
        y      = 21
        width  = 24
        height = 1
        properties = {
          markdown = "## Auth-sync + me — new-user onboarding + self-read. Errors here break silently for fresh sign-ups."
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 22
        width  = 12
        height = 6
        properties = {
          title  = "Auth-sync + me — errors (Sum)"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in local.auth_sync_functions :
            ["AWS/Lambda", "Errors", "FunctionName", name, { label = key }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 22
        width  = 12
        height = 6
        properties = {
          title  = "Auth-sync + me — Lambda duration p95 (ms)"
          region = var.region
          period = 300
          view   = "timeSeries"
          metrics = [
            for key, name in local.auth_sync_functions :
            ["AWS/Lambda", "Duration", "FunctionName", name, { stat = "p95", label = key }]
          ]
        }
      },
    ]
  })
}

# WAF + EventBridge — security + scheduled-job health.
resource "aws_cloudwatch_dashboard" "waf_eventbridge" {
  dashboard_name = "${local.base_name}-waf-eventbridge"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "WAF allowed / blocked"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/WAFV2", "AllowedRequests", "WebACL", var.waf_web_acl_name, "Region", var.region, "Rule", "ALL"],
            [".", "BlockedRequests", ".", ".", ".", ".", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "EventBridge reminder rule"
          region = var.region
          stat   = "Sum"
          period = 300
          view   = "timeSeries"
          metrics = [
            ["AWS/Events", "Invocations", "RuleName", var.eventbridge_rule_name],
            [".", "FailedInvocations", ".", "."],
          ]
        }
      },
    ]
  })
}
