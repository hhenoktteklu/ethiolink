# EthioLink — Lambda module outputs.
#
# Consumed by:
#   * `api-gateway` module — needs `function_arns` to wire each
#     route's `aws_apigatewayv2_integration` (or REST equivalent).
#     The `function_invoke_arns` are the values API Gateway
#     actually invokes; ARNs are for IAM scoping.
#   * `eventbridge` module — the `scheduled-send-reminders` ARN
#     is the target of the 15-minute cron rule.
#   * Manual operator surfaces — `aws lambda invoke` for smoke
#     tests against a specific function.

output "execution_role_arns" {
  description = "Map of domain area → execution-role ARN (e.g. `auth` → `arn:aws:iam::123:role/ethiolink-dev-lambda-exec-auth`). Phase 8 replaced the single shared role with per-domain roles; downstream modules that want to attach additional permissions should target the specific area's role."
  value       = { for k, role in aws_iam_role.lambda_exec : k => role.arn }
}

output "execution_role_names" {
  description = "Map of domain area → execution-role name."
  value       = { for k, role in aws_iam_role.lambda_exec : k => role.name }
}

output "function_names" {
  description = "Map of logical id → function name (e.g. `auth-sync` → `ethiolink-dev-auth-sync`). Use this for any future `aws lambda invoke` script or for CloudWatch dashboard widgets."
  value       = { for k, fn in aws_lambda_function.function : k => fn.function_name }
}

output "function_arns" {
  description = "Map of logical id → function ARN. The API Gateway module looks each route's handler up here when wiring integrations."
  value       = { for k, fn in aws_lambda_function.function : k => fn.arn }
}

output "function_invoke_arns" {
  description = "Map of logical id → invoke ARN. This is the ARN that API Gateway integrations + EventBridge targets actually invoke; distinct from `function_arns` (which is the regular ARN used in IAM policies)."
  value       = { for k, fn in aws_lambda_function.function : k => fn.invoke_arn }
}

output "log_group_names" {
  description = "Map of logical id → CloudWatch log group name. The cloudwatch module reads this to attach metric filters / dashboards per function."
  value       = { for k, lg in aws_cloudwatch_log_group.function : k => lg.name }
}

output "scheduled_reminders_function_arn" {
  description = "Convenience output: the ARN of the `scheduled-send-reminders` function. The EventBridge module's target attribute consumes this directly."
  value       = aws_lambda_function.function["scheduled-send-reminders"].arn
}

output "scheduled_reminders_function_name" {
  description = "Convenience output: name of the `scheduled-send-reminders` function. Useful for `aws lambda invoke --function-name <name>` smoke tests."
  value       = aws_lambda_function.function["scheduled-send-reminders"].function_name
}

output "db_migrate_function_arn" {
  description = "Convenience output: the ARN of the `maintenance-db-migrate` function. Operators run `aws lambda invoke --function-name <name>` against this after every Terraform apply that ships a new migration."
  value       = aws_lambda_function.function["maintenance-db-migrate"].arn
}

output "db_migrate_function_name" {
  description = "Convenience output: name of the `maintenance-db-migrate` function (e.g. `ethiolink-dev-maintenance-db-migrate`)."
  value       = aws_lambda_function.function["maintenance-db-migrate"].function_name
}
