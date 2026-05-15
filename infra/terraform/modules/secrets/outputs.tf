# EthioLink — secrets-rotation module outputs.

output "rotation_enabled" {
  description = "Whether rotation is provisioned in this env. Reflects `var.enabled` directly — when `false`, none of the other outputs have meaningful values."
  value       = var.enabled
}

output "rotation_lambda_arn" {
  description = "ARN of the SAR-deployed rotation Lambda. `null` when rotation is disabled. Consumed by `aws cloudwatch describe-alarms` for failure-rate monitoring + by the operator for mid-rotation troubleshooting via `aws lambda invoke`."
  value       = var.enabled ? data.aws_lambda_function.rotation[0].arn : null
}

output "rotation_lambda_name" {
  description = "Name of the rotation Lambda (`${name_prefix}-${environment}-rds-rotation`). `null` when rotation is disabled. Useful for `aws logs tail /aws/lambda/<name>` during incident response."
  value       = var.enabled ? data.aws_lambda_function.rotation[0].function_name : null
}

output "rotation_days" {
  description = "Number of days between scheduled rotations, echoed from the input variable."
  value       = var.rotation_days
}
