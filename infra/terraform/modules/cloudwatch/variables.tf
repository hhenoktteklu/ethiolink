# EthioLink — CloudWatch monitoring module inputs.
#
# Provisions per-environment SNS topic + 7 alarms + 4 dashboards.
# Every upstream module's identifier is threaded in through this
# variable list — the module is the integration point that turns
# infrastructure outputs into operational visibility.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in resource names, metric labels, and SNS topic display name."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment + suffix."
  type        = string
  default     = "ethiolink"
}

variable "region" {
  description = "AWS region. Used in dashboard widget configuration so metric panels render in the right region."
  type        = string
  default     = "eu-west-1"
}

# -----------------------------------------------------------------------------
# Notification target
# -----------------------------------------------------------------------------

variable "alarm_email" {
  description = "Operator email to subscribe to the alarm SNS topic. Empty string (the default) skips the subscription — useful for the initial Terraform apply when no operator address is finalized yet. The subscription requires manual confirmation by clicking the link AWS sends to the address; until then, alarms still fire and post to SNS but no email is delivered."
  type        = string
  default     = ""
}

# -----------------------------------------------------------------------------
# Upstream identifiers — sourced from sibling Phase 7 modules.
# -----------------------------------------------------------------------------

variable "rest_api_id" {
  description = "API Gateway REST API id. Sourced from `module.api_gateway.rest_api_id`."
  type        = string
}

variable "api_gateway_stage_name" {
  description = "API Gateway stage name. Sourced from `module.api_gateway.stage_name`."
  type        = string
}

variable "lambda_function_names" {
  description = "Map of logical id → Lambda function name. Sourced from `module.lambda.function_names`. The Lambda dashboard renders one widget per function; the aggregated alarm watches namespace-wide errors."
  type        = map(string)
}

variable "rds_instance_identifier" {
  description = "RDS instance identifier. Sourced from `module.rds.db_instance_identifier`."
  type        = string
}

variable "eventbridge_rule_name" {
  description = "Name of the scheduled-reminder EventBridge rule. Sourced from `module.eventbridge.rule_name`."
  type        = string
}

variable "waf_web_acl_name" {
  description = "Name of the WAFv2 Web ACL. Sourced from `module.waf.web_acl_name`."
  type        = string
}

# -----------------------------------------------------------------------------
# Alarm thresholds — every one is variabled so a real on-call
# event can tune them without a module change.
# -----------------------------------------------------------------------------

variable "api_gateway_5xx_threshold" {
  description = "5xx error count per 5 minutes that triggers the API Gateway alarm. Default 5 — generous baseline; tune down once steady-state traffic is established."
  type        = number
  default     = 5
}

variable "lambda_errors_threshold" {
  description = "Total Lambda errors per 5 minutes across all functions in the account before the aggregate alarm fires. Default 5. The dashboard's per-function widgets are the drilldown when this fires."
  type        = number
  default     = 5
}

variable "rds_cpu_threshold_percent" {
  description = "RDS CPU utilization percent over 5 minutes that triggers the CPU alarm. Default 80. AWS RDS CPU > 80% sustained is usually the precursor to connection exhaustion."
  type        = number
  default     = 80
}

variable "rds_connections_threshold" {
  description = "RDS open-connection count over 5 minutes that triggers the connections alarm. Default 80 — based on Postgres `max_connections = 100` (RDS default); tune up when RDS Proxy multiplexes more efficiently."
  type        = number
  default     = 80
}

variable "rds_free_storage_threshold_bytes" {
  description = "RDS free-storage bytes below which the storage alarm fires. Default 5 GiB. Storage autoscaling will already be growing the volume — this alarm is the fallback when autoscaling lags."
  type        = number
  default     = 5368709120 # 5 GiB
}

variable "eventbridge_failed_invocations_threshold" {
  description = "Number of EventBridge `FailedInvocations` per 5 minutes that triggers the reminder-rule alarm. Default 1 — any single failure is a signal worth investigating; the reminder lambda is best-effort but a sustained failure rate means the rule never reaches the Lambda."
  type        = number
  default     = 1
}

variable "waf_blocked_requests_threshold" {
  description = "WAF blocked-request count per 5 minutes that triggers the WAF alarm. Default 100. A spike usually means either a real attack (good — the rules are working) or a managed-rule false-positive (bad — operator needs to tune)."
  type        = number
  default     = 100
}

# -----------------------------------------------------------------------------
# Phase 8 — SLO-burn alarm thresholds.
#
# Both alarms below are fast-burn proxies for the long-window SLOs
# in `docs/operations/SLOs.md`. They fire well before the actual
# 30-day budget is in danger so the operator gets a real-time
# signal; the long-window SLO numbers are the post-hoc reckoning
# rather than the alerting surface.
# -----------------------------------------------------------------------------

variable "slo_booking_creation_errors_threshold" {
  description = "Lambda `Errors` count on the `appointments-create` function per 5 minutes before the booking-creation SLO-burn alarm fires. Default 3 — at ~10 RPS sustained booking attempts, 3 errors / 5 min is ~1% error rate, twice the 0.5% SLO miss rate. See `docs/operations/SLOs.md` §1."
  type        = number
  default     = 3
}

variable "slo_browse_latency_p95_ms" {
  description = "Lambda `Duration` p95 (milliseconds) on the `businesses-list` function above which the browse-latency SLO-burn alarm fires. Default 800 — same value as the SLO target so a sustained breach (2 consecutive 5-min windows) trips the alarm before the rolling-7-day p95 itself slips. See `docs/operations/SLOs.md` §2."
  type        = number
  default     = 800
}

variable "log_retention_days" {
  description = "Days to retain alarm SNS delivery logs (when CloudTrail captures them later). Not currently used; reserved for a future expansion that also retains SNS subscription event logs."
  type        = number
  default     = 30
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}
