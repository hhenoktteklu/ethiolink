# EthioLink — Terraform bootstrap outputs.
#
# The values exported here are the inputs that the per-environment
# `backend.tf` files and the GitHub Actions workflows reference.
# Outputs are stable identifiers (names + ARNs), not regenerated
# secrets — every value below is safe to surface in CI logs.

output "state_bucket_name" {
  description = "Name of the S3 bucket holding Terraform remote state for every environment. Reference in each environment's `backend.tf` `bucket` field."
  value       = aws_s3_bucket.terraform_state.id
}

output "state_bucket_arn" {
  description = "ARN of the S3 state bucket. Useful for cross-account state-import scripts that may land in a future phase."
  value       = aws_s3_bucket.terraform_state.arn
}

output "lock_table_name" {
  description = "Name of the DynamoDB table holding the `LockID`-keyed Terraform advisory locks. Reference in each environment's `backend.tf` `dynamodb_table` field."
  value       = aws_dynamodb_table.terraform_locks.id
}

output "github_oidc_provider_arn" {
  description = "ARN of the GitHub Actions OIDC identity provider. Trust-policy fixture for any future role that needs to be assumed from this same repository."
  value       = aws_iam_openid_connect_provider.github.arn
}

output "terraform_deploy_role_arn" {
  description = "ARN of the IAM role assumed by `terraform-plan.yml` + `deploy-dev.yml`. Trust condition: `repo:<owner>/<repo>:*` (any ref). Pass this to `aws-actions/configure-aws-credentials@v4` via the `role-to-assume` input. The current role carries AdministratorAccess — temporarily, while Phase 7 + early Phase 8 modules land."
  value       = aws_iam_role.terraform_deploy.arn
}

output "terraform_deploy_prod_role_arn" {
  description = "ARN of the IAM role assumed by `deploy-prod.yml` only. Trust condition: `repo:<owner>/<repo>:ref:refs/tags/v*` — push-to-main runs cannot assume it. The `deploy-prod.yml` workflow's `role-to-assume` input takes this ARN; pair with the `environment: prod` manual-approval gate inside the workflow for defense in depth."
  value       = aws_iam_role.terraform_deploy_prod.arn
}

output "region" {
  description = "AWS region in which the bootstrap resources live. The state bucket + lock table are regional; the IAM provider + role are global but require a provider region for the API call."
  value       = var.region
}
