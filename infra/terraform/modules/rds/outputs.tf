# EthioLink — RDS module outputs.
#
# Consumed by:
#   * `lambda` module — picks the effective endpoint (proxy when
#     enabled, else direct), threads the master-secret ARN into
#     the execution role for the cold-start password lookup.
#   * Migration runner — same secret ARN + direct DB endpoint
#     (migrations always run against the instance, never via the
#     proxy, to avoid the proxy's prepared-statement caching
#     interfering with DDL).
#   * Manual operator surfaces — `psql` connection strings, smoke
#     tests, and the future bastion EC2 host.

output "db_endpoint" {
  description = "Direct DB instance endpoint (`<id>.<random>.<region>.rds.amazonaws.com`). Use for DDL / migrations even when the proxy is enabled."
  value       = aws_db_instance.this.address
}

output "db_port" {
  description = "PostgreSQL port. Defaults to 5432 — exposed as an output so the consuming Lambda env doesn't have to hardcode it."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Initial database name on the instance. Maps to the `PG_DATABASE` Lambda env."
  value       = aws_db_instance.this.db_name
}

output "db_instance_identifier" {
  description = "RDS instance identifier. Useful for `aws rds` CLI commands and for the `db_instance_identifier` field inside the master secret JSON."
  value       = aws_db_instance.this.identifier
}

output "db_instance_arn" {
  description = "ARN of the DB instance. Useful for IAM policy scoping on the Lambda execution role (e.g. RDS IAM auth in a future hardening commit) and for CloudWatch alarms."
  value       = aws_db_instance.this.arn
}

output "master_secret_arn" {
  description = "ARN of the Secrets Manager secret carrying the master credentials. Maps to a `*_SECRET_ARN` Lambda env that the cold-start shim reads via `secretsmanager:GetSecretValue` before `loadConfig`."
  value       = aws_secretsmanager_secret.master.arn
}

output "master_secret_name" {
  description = "Stable name of the master credentials secret (`ethiolink/${var.environment}/rds/master`). Useful for `aws secretsmanager` CLI calls that prefer name over ARN."
  value       = aws_secretsmanager_secret.master.name
}

output "proxy_endpoint" {
  description = "RDS Proxy endpoint when `enable_rds_proxy = true`; `null` otherwise. Application connections in prod target this hostname so Lambda concurrency multiplexes across a bounded number of upstream DB connections."
  value       = var.enable_rds_proxy ? aws_db_proxy.this[0].endpoint : null
}

output "proxy_arn" {
  description = "RDS Proxy ARN when enabled; `null` otherwise."
  value       = var.enable_rds_proxy ? aws_db_proxy.this[0].arn : null
}

output "proxy_security_group_id" {
  description = "Security group attached to the RDS Proxy when enabled; `null` otherwise. Lambdas that talk to the proxy must be allowed by this SG's ingress rules (already configured by the module: ingress from the `rds_security_group_id` set, which already includes the Lambda SG)."
  value       = var.enable_rds_proxy ? aws_security_group.proxy[0].id : null
}

output "effective_endpoint" {
  description = "Convenience output: the proxy endpoint when enabled, else the direct DB endpoint. Lambda env-wiring reads this to avoid a per-env conditional at the call site."
  value       = var.enable_rds_proxy ? aws_db_proxy.this[0].endpoint : aws_db_instance.this.address
}
