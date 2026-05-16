# EthioLink — WAF module outputs.
#
# Consumed by:
#   * `cloudwatch` module — needs `web_acl_arn` to attach alarms
#     on blocked-request rate, rate-limit triggers, and individual
#     rule-group block counts.
#   * Operator surfaces — `aws wafv2 get-sampled-requests --web-acl-arn <arn>` for
#     mid-incident investigation.

output "web_acl_id" {
  description = "Web ACL id (just the UUID, not the full ARN)."
  value       = aws_wafv2_web_acl.this.id
}

output "web_acl_arn" {
  description = "Web ACL ARN. The CloudWatch alarm module references this to attach `BlockedRequests` / `AllowedRequests` metric filters."
  value       = aws_wafv2_web_acl.this.arn
}

output "web_acl_name" {
  description = "Web ACL name (`ethiolink-<environment>-api-waf`). Useful for `aws wafv2` CLI calls that prefer name over ARN."
  value       = aws_wafv2_web_acl.this.name
}

output "web_acl_capacity" {
  description = "WCU consumption of the ACL. AWS WAFv2 caps an ACL at 1500 WCUs; exposing this lets the operator see headroom before adding more rules."
  value       = aws_wafv2_web_acl.this.capacity
}

# -----------------------------------------------------------------------------
# Per-rule CloudWatch metric names.
#
# WAFv2 emits a metric per rule under the `AWS/WAFV2` namespace,
# keyed on the rule's `visibility_config.metric_name`. The
# CloudWatch module attaches alarms via this map rather than
# hard-coding the names. Skipped rules (e.g. Bot Control when
# disabled) still appear in the map with a `null` value so the
# consumer can compact-filter consistently.
# -----------------------------------------------------------------------------

output "rule_metric_names" {
  description = "Map of rule key → CloudWatch metric name (under `AWS/WAFV2`). Consumers attach alarms by name; `null` entries indicate the rule is disabled this environment."
  value = {
    common_rule_set     = var.enable_common_rule_set ? "${local.base_name}-common-rule-set" : null
    known_bad_inputs    = var.enable_known_bad_inputs ? "${local.base_name}-known-bad-inputs" : null
    ip_reputation       = var.enable_ip_reputation ? "${local.base_name}-ip-reputation" : null
    bot_control         = var.enable_bot_control ? "${local.base_name}-bot-control" : null
    rate_limit_public_read = var.rate_limit_public_read_per_5min != null ? "${local.base_name}-rate-limit-public-read" : null
    rate_limit_write    = var.rate_limit_write_per_5min != null ? "${local.base_name}-rate-limit-write" : null
    rate_limit_global   = "${local.base_name}-rate-limit"
  }
}
