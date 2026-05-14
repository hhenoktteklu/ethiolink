# EthioLink — Cognito module outputs.
#
# Surfaced so that environment Terraform can:
#   - feed user pool / app client ids into the Lambda config and the API
#     Gateway authorizer;
#   - print the values for backend/.env after `terraform apply`.

output "user_pool_id" {
  description = "Cognito user pool id. Used by the API Gateway authorizer and the backend JWT verifier."
  value       = aws_cognito_user_pool.this.id
}

output "user_pool_arn" {
  description = "Cognito user pool ARN. Used by API Gateway when authorizing requests."
  value       = aws_cognito_user_pool.this.arn
}

output "user_pool_endpoint" {
  description = "Cognito user pool endpoint (issuer URL component)."
  value       = aws_cognito_user_pool.this.endpoint
}

output "user_pool_name" {
  description = "Resolved user pool name."
  value       = aws_cognito_user_pool.this.name
}

output "mobile_app_client_id" {
  description = "App client id for the Flutter mobile app. Public client; no secret."
  value       = aws_cognito_user_pool_client.mobile.id
}

output "admin_app_client_id" {
  description = "App client id for the React admin dashboard."
  value       = aws_cognito_user_pool_client.admin.id
}

output "admin_app_client_secret" {
  description = "App client secret for the React admin dashboard. Sensitive."
  value       = aws_cognito_user_pool_client.admin.client_secret
  sensitive   = true
}

output "hosted_ui_domain" {
  description = "Cognito hosted-UI domain prefix (sub-domain on the shared amazoncognito.com zone)."
  value       = aws_cognito_user_pool_domain.this.domain
}

output "group_names" {
  description = "Names of the role groups provisioned in the user pool."
  value = {
    customer       = aws_cognito_user_group.customer.name
    business_owner = aws_cognito_user_group.business_owner.name
    admin          = aws_cognito_user_group.admin.name
  }
}
