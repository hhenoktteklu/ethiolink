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
  description = "Rate-based-rule threshold: requests per 5 minutes per source IP before the rule blocks the IP. AWS hard floor is 100; we default to 2000 (~6.7 req/sec per IP sustained) — generous for legitimate clients, restrictive for trivial scrapers. Tune on the first load test."
  type        = number
  default     = 2000

  validation {
    condition     = var.rate_limit_per_5min >= 100 && var.rate_limit_per_5min <= 20000000
    error_message = "rate_limit_per_5min must be between 100 and 20,000,000 (the WAFv2 limits)."
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

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}
