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
  description = "Web ACL name (`ethiolink-${var.environment}-api-waf`). Useful for `aws wafv2` CLI calls that prefer name over ARN."
  value       = aws_wafv2_web_acl.this.name
}

output "web_acl_capacity" {
  description = "WCU consumption of the ACL. AWS WAFv2 caps an ACL at 1500 WCUs; exposing this lets the operator see headroom before adding more rules."
  value       = aws_wafv2_web_acl.this.capacity
}
