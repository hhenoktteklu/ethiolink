# EthioLink — EventBridge module outputs.
#
# Consumed by:
#   * `cloudwatch` module — needs `rule_arn` to attach a metric
#     filter / alarm on the rule's `FailedInvocations`.
#   * Manual operator surfaces — `aws events list-targets-by-rule
#     --rule <rule_name>` for smoke checks.

output "rule_arn" {
  description = "ARN of the scheduled-reminder EventBridge rule. The CloudWatch alarm on `FailedInvocations` (future commit) references this."
  value       = aws_cloudwatch_event_rule.send_reminders.arn
}

output "rule_name" {
  description = "Name of the scheduled-reminder EventBridge rule. Useful for `aws events describe-rule --name <rule_name>` smoke tests."
  value       = aws_cloudwatch_event_rule.send_reminders.name
}

output "rule_state" {
  description = "ENABLED / DISABLED depending on `var.enabled`. Returned so a downstream module / smoke test can verify the rule is firing as expected."
  value       = aws_cloudwatch_event_rule.send_reminders.state
}

output "featuring_sweep_rule_arn" {
  description = "ARN of the Phase 9 Track 6 featuring sweep EventBridge rule, or `null` when not wired in this env."
  value       = length(aws_cloudwatch_event_rule.featuring_sweep) > 0 ? aws_cloudwatch_event_rule.featuring_sweep[0].arn : null
}

output "featuring_sweep_rule_name" {
  description = "Name of the Phase 9 Track 6 featuring sweep EventBridge rule, or `null` when not wired in this env."
  value       = length(aws_cloudwatch_event_rule.featuring_sweep) > 0 ? aws_cloudwatch_event_rule.featuring_sweep[0].name : null
}
