# EthioLink — WAF module inputs.
#
# Provisions one regional WAFv2 Web ACL per environment and
# associates it with the API Gateway stage. Three AWS-managed rule
# groups plus a rate-based rule per IP.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in resource names + CloudWatch metric labels."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form the ACL name (`ethiolink-dev-api-waf`)."
  type        = string
  default     = "ethiolink"
}

variable "api_gateway_stage_arn" {
  description = "Stage ARN to associate the Web ACL with. Format: `arn:aws:apigateway:<region>::/restapis/<rest-api-id>/stages/<stage-name>`. The env stack constructs this from the API Gateway module outputs."
  type        = string
}

variable "rate_limit_per_5min" {
  description = "Global rate-based-rule threshold (the existing fallback, priority 70): requests per 5 minutes per source IP before the rule blocks the IP — counted across every request, regardless of method or path. AWS hard floor is 100; we default to 2000 (~6.7 req/sec per IP sustained) — generous for legitimate clients, restrictive for trivial scrapers. Tune on the first load test."
  type        = number
  default     = 2000

  validation {
    condition     = var.rate_limit_per_5min >= 100 && var.rate_limit_per_5min <= 20000000
    error_message = "rate_limit_per_5min must be between 100 and 20,000,000 (the WAFv2 limits)."
  }
}

variable "rate_limit_public_read_per_5min" {
  description = "Tighter rate limit (priority 50) applied only to public marketplace reads — method=GET on `/v1/categories*` or `/v1/businesses*`. Catches catalog scraping early without affecting writes / admin reads. Default 600 (~2 req/sec sustained). Set to `null` to disable the rule. AWS hard floor is 100."
  type        = number
  default     = 600

  validation {
    condition     = var.rate_limit_public_read_per_5min == null || (var.rate_limit_public_read_per_5min != null && var.rate_limit_public_read_per_5min >= 100 && var.rate_limit_public_read_per_5min <= 20000000)
    error_message = "rate_limit_public_read_per_5min must be null or between 100 and 20,000,000."
  }
}

variable "rate_limit_write_per_5min" {
  description = "Tighter rate limit (priority 60) applied only to non-GET methods (POST / PATCH / PUT / DELETE) across every path. Catches booking-write abuse + login brute-force attempts. Default 300 (~1 write/sec sustained). Set to `null` to disable the rule. AWS hard floor is 100."
  type        = number
  default     = 300

  validation {
    condition     = var.rate_limit_write_per_5min == null || (var.rate_limit_write_per_5min != null && var.rate_limit_write_per_5min >= 100 && var.rate_limit_write_per_5min <= 20000000)
    error_message = "rate_limit_write_per_5min must be null or between 100 and 20,000,000."
  }
}

variable "enable_common_rule_set" {
  description = "Toggle the `AWSManagedRulesCommonRuleSet` group. Default true. False is reserved for the rare case where a managed rule false-positives a real workload and the operator wants to drop the rule mid-incident — the disable knob lives here rather than in CloudWatch so the change is auditable in git."
  type        = bool
  default     = true
}

variable "enable_known_bad_inputs" {
  description = "Toggle the `AWSManagedRulesKnownBadInputsRuleSet` group. Default true."
  type        = bool
  default     = true
}

variable "enable_ip_reputation" {
  description = "Toggle the `AWSManagedRulesAmazonIpReputationList` group. Default true. Blocks traffic from known-bad IP reputation feeds AWS maintains."
  type        = bool
  default     = true
}

variable "enable_bot_control" {
  description = "Toggle the `AWSManagedRulesBotControlRuleSet` group. Default false because Bot Control is priced per-request and the MVP traffic profile doesn't yet justify the cost. Flip to true once real traffic numbers show a residual bot share the other groups don't catch. `bot_control_inspection_level` selects between COMMON (cheap) and TARGETED (full)."
  type        = bool
  default     = false
}

variable "bot_control_inspection_level" {
  description = "Inspection level for `AWSManagedRulesBotControlRuleSet` when `enable_bot_control = true`. `COMMON` (~50 WCUs) covers JA3 + common bot families and is the recommended starting point; `TARGETED` (~500 WCUs) adds CAPTCHA + behavioral signals at higher cost. Ignored when `enable_bot_control = false`."
  type        = string
  default     = "COMMON"

  validation {
    condition     = contains(["COMMON", "TARGETED"], var.bot_control_inspection_level)
    error_message = "bot_control_inspection_level must be one of: COMMON, TARGETED."
  }
}

# -----------------------------------------------------------------------------
# Per-managed-group sub-rule action overrides.
#
# Each list below names sub-rules inside the corresponding managed
# group that should be forced to `COUNT` (observability only, no
# block) instead of the group's default action. Typical use is
# mid-incident — a managed sub-rule false-positives a real
# workload, the operator adds the name here, re-applies, and keeps
# observability without taking the block hit. The lists default to
# empty.
#
# Sub-rule names live in AWS's docs for each managed group, e.g.
# `SizeRestrictions_BODY`, `CrossSiteScripting_QUERYARGUMENTS`. The
# canonical list also appears in the AWS console under "Manage
# rules" for the group. `aws wafv2 describe-managed-rule-group --vendor-name AWS --name <Group>`
# lists them programmatically.
#
# To force a sub-rule to a different action (e.g. CAPTCHA, ALLOW)
# instead of COUNT, edit `main.tf` directly — the `action_to_use`
# block accepts `allow {}` / `block {}` / `count {}` / `captcha {}` /
# `challenge {}`. The module exposes COUNT only because it's the
# overwhelming operational use case; the rarer overrides stay
# explicit-code-change to keep the variable surface small.
# -----------------------------------------------------------------------------

variable "common_rule_set_count_overrides" {
  description = "Names of sub-rules inside `AWSManagedRulesCommonRuleSet` to force to `COUNT` instead of the group's default action. Default empty list = honor the group's actions as-is. See module header for the override pattern."
  type        = list(string)
  default     = []
}

variable "known_bad_inputs_count_overrides" {
  description = "Names of sub-rules inside `AWSManagedRulesKnownBadInputsRuleSet` to force to `COUNT`. Default empty list."
  type        = list(string)
  default     = []
}

variable "ip_reputation_count_overrides" {
  description = "Names of sub-rules inside `AWSManagedRulesAmazonIpReputationList` to force to `COUNT`. Default empty list. Rarely needed — the IP-reputation group has a small sub-rule surface."
  type        = list(string)
  default     = []
}

variable "bot_control_count_overrides" {
  description = "Names of sub-rules inside `AWSManagedRulesBotControlRuleSet` to force to `COUNT`. Default empty list. Ignored when `enable_bot_control = false`."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}
