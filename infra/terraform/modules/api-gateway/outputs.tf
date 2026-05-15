# EthioLink — API Gateway module outputs.
#
# Consumed by:
#   * Admin SPA build — `invoke_url` is baked into the Vite bundle
#     as `VITE_API_BASE_URL` so the dashboard knows where to send
#     `fetch('/v1/admin/...')`.
#   * Mobile app build — same surface, different env file.
#   * Smoke-test scripts (Phase 7 last commit) — `curl
#     "${invoke_url}/v1/categories"` should return 200 + the seeded
#     category list.

output "rest_api_id" {
  description = "API Gateway REST API id. Useful for `aws apigateway` CLI calls and for WAF association in the WAF module commit."
  value       = aws_api_gateway_rest_api.this.id
}

output "rest_api_arn" {
  description = "REST API ARN. WAF + CloudWatch dashboards reference this."
  value       = aws_api_gateway_rest_api.this.arn
}

output "execution_arn" {
  description = "Execution ARN of the REST API. Used to scope `aws_lambda_permission.source_arn` — kept identical here so a follow-up commit that splits per-domain IAM roles can reference it directly."
  value       = aws_api_gateway_rest_api.this.execution_arn
}

output "stage_name" {
  description = "Stage name (= environment name)."
  value       = aws_api_gateway_stage.this.stage_name
}

output "invoke_url" {
  description = "Base URL the clients hit. Built from `<api-id>.execute-api.<region>.amazonaws.com/<stage>` — no custom domain in this commit; prod custom-domain wiring is a separate Phase 7 follow-up."
  value       = "https://${aws_api_gateway_rest_api.this.id}.execute-api.${var.region}.amazonaws.com/${aws_api_gateway_stage.this.stage_name}"
}

output "authorizer_id" {
  description = "Cognito authorizer id. Reserved for a future commit that adds new routes and wants to attach the same authorizer without re-creating it."
  value       = aws_api_gateway_authorizer.cognito.id
}
