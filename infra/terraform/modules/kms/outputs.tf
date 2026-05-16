# EthioLink — KMS module outputs.
#
# Two shapes per service: the ARN (what every AWS resource that
# wires a CMK expects on its `kms_key_id` / `kms_key_arn` input)
# and the key id (the bare UUID, sometimes wanted for IAM
# `Condition: kms:KeyId` filters or for CLI smoke tests that
# resolve aliases). Plus an aggregated `key_arns` map for callers
# that prefer a single output to thread through (e.g. a future
# observability dashboard listing every CMK in the env).

output "rds_key_arn" {
  description = "ARN of the RDS encryption key. Will be wired into `module.rds`'s `kms_key_id` input in the follow-up commit; until then it stands by unused."
  value       = aws_kms_key.rds.arn
}

output "rds_key_id" {
  description = "Key id of the RDS encryption key."
  value       = aws_kms_key.rds.key_id
}

output "s3_media_key_arn" {
  description = "ARN of the public + private media bucket encryption key. Will be wired into `module.s3`'s `media_kms_key_arn` input in the follow-up commit."
  value       = aws_kms_key.s3_media.arn
}

output "s3_media_key_id" {
  description = "Key id of the media bucket encryption key."
  value       = aws_kms_key.s3_media.key_id
}

output "s3_logs_key_arn" {
  description = "ARN of the S3 server-access-logs bucket encryption key. Kept separate from `s3_media_key_arn` so an audit-side grant on logs doesn't widen access to customer-facing media."
  value       = aws_kms_key.s3_logs.arn
}

output "s3_logs_key_id" {
  description = "Key id of the logs bucket encryption key."
  value       = aws_kms_key.s3_logs.key_id
}

output "s3_admin_frontend_key_arn" {
  description = "ARN of the admin SPA bucket encryption key. The CloudFront OAC service principal carries `kms:Decrypt` on this key via the key policy in this module."
  value       = aws_kms_key.s3_admin_frontend.arn
}

output "s3_admin_frontend_key_id" {
  description = "Key id of the admin SPA bucket encryption key."
  value       = aws_kms_key.s3_admin_frontend.key_id
}

output "secrets_key_arn" {
  description = "ARN of the Secrets Manager encryption key. Covers `ethiolink/<environment>/rds/master` today; future third-party API-key secrets (SMS, Telegram, payment provider) will use the same key."
  value       = aws_kms_key.secrets.arn
}

output "secrets_key_id" {
  description = "Key id of the Secrets Manager encryption key."
  value       = aws_kms_key.secrets.key_id
}

output "lambda_env_key_arn" {
  description = "ARN of the Lambda environment-variable encryption key. Will be wired into `module.lambda`'s `kms_key_arn` input in the follow-up commit."
  value       = aws_kms_key.lambda_env.arn
}

output "lambda_env_key_id" {
  description = "Key id of the Lambda env-var encryption key."
  value       = aws_kms_key.lambda_env.key_id
}

# Aggregated views.

output "key_arns" {
  description = "Map of service slug → key ARN. Convenience output for the env stack to print a single block listing every CMK in this env, and for future observability dashboards to enumerate keys without naming each one explicitly."
  value = {
    rds               = aws_kms_key.rds.arn
    s3_media          = aws_kms_key.s3_media.arn
    s3_logs           = aws_kms_key.s3_logs.arn
    s3_admin_frontend = aws_kms_key.s3_admin_frontend.arn
    secrets           = aws_kms_key.secrets.arn
    lambda_env        = aws_kms_key.lambda_env.arn
  }
}

output "key_ids" {
  description = "Map of service slug → bare key id. Same membership as `key_arns`; useful for IAM `Condition: kms:KeyId` filters that take the id rather than the ARN."
  value = {
    rds               = aws_kms_key.rds.key_id
    s3_media          = aws_kms_key.s3_media.key_id
    s3_logs           = aws_kms_key.s3_logs.key_id
    s3_admin_frontend = aws_kms_key.s3_admin_frontend.key_id
    secrets           = aws_kms_key.secrets.key_id
    lambda_env        = aws_kms_key.lambda_env.key_id
  }
}

output "alias_names" {
  description = "Map of service slug → alias name (without the `arn:aws:kms:...` prefix, but with the `alias/` schema). Useful for CLI smoke tests (`aws kms describe-key --key-id <alias>`)."
  value = {
    rds               = aws_kms_alias.rds.name
    s3_media          = aws_kms_alias.s3_media.name
    s3_logs           = aws_kms_alias.s3_logs.name
    s3_admin_frontend = aws_kms_alias.s3_admin_frontend.name
    secrets           = aws_kms_alias.secrets.name
    lambda_env        = aws_kms_alias.lambda_env.name
  }
}
