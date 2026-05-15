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
