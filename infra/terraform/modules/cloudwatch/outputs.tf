# EthioLink — CloudWatch monitoring outputs.

output "alarm_sns_topic_arn" {
  description = "ARN of the SNS topic alarms post to. A future migration-runner or smoke-test workflow that wants its own alarms attaches to this same topic so all operator notifications land in the same inbox."
  value       = aws_sns_topic.alarms.arn
}

output "alarm_sns_topic_name" {
  description = "Name of the alarm SNS topic."
  value       = aws_sns_topic.alarms.name
}

output "dashboard_names" {
  description = "Map of dashboard key → dashboard name. Useful for `aws cloudwatch get-dashboard --dashboard-name <name>` smoke checks."
  value = {
    api_gateway     = aws_cloudwatch_dashboard.api_gateway.dashboard_name
    lambda          = aws_cloudwatch_dashboard.lambda.dashboard_name
    rds             = aws_cloudwatch_dashboard.rds.dashboard_name
    waf_eventbridge = aws_cloudwatch_dashboard.waf_eventbridge.dashboard_name
  }
}

output "alarm_names" {
  description = "List of alarm names provisioned by this module. Useful for `aws cloudwatch describe-alarms` filtering during incident investigation."
  value = [
    aws_cloudwatch_metric_alarm.api_gateway_5xx.alarm_name,
    aws_cloudwatch_metric_alarm.lambda_errors.alarm_name,
    aws_cloudwatch_metric_alarm.rds_cpu.alarm_name,
    aws_cloudwatch_metric_alarm.rds_connections.alarm_name,
    aws_cloudwatch_metric_alarm.rds_free_storage.alarm_name,
    aws_cloudwatch_metric_alarm.eventbridge_failed_invocations.alarm_name,
    aws_cloudwatch_metric_alarm.waf_blocked_requests.alarm_name,
  ]
}
