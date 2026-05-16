# EthioLink — RDS module inputs.
#
# Provisions one PostgreSQL 15 instance per environment plus the
# Secrets Manager secret that carries the master password. Prod
# additionally wires an RDS Proxy in front of the instance to keep
# Lambda connection pressure off the DB; dev hits the instance
# directly because dev traffic doesn't justify the proxy cost.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in resource identifiers, the Secrets Manager secret name, and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form names like \"ethiolink-dev-rds\"."
  type        = string
  default     = "ethiolink"
}

variable "vpc_id" {
  description = "VPC the instance + proxy live in. Sourced from the `vpc` module output."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet ids hosting the DB subnet group. Must span at least two AZs when `multi_az = true` (RDS rejects Multi-AZ requests against a subnet group with fewer than two AZs)."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "private_subnet_ids must include at least two subnets across different AZs."
  }
}

variable "rds_security_group_id" {
  description = "Security group id attached to the DB instance. Sourced from the `vpc` module — already configured to accept ingress on 5432 from `sg-lambda` (and the bastion SG in prod)."
  type        = string
}

variable "instance_class" {
  description = "RDS instance class. MVP defaults: `db.t4g.small` for dev (burstable, ARM, ~$25/mo); `db.m6g.large` for prod (steady, ARM, ~$165/mo). Revisit prod sizing after the first load test."
  type        = string
  default     = "db.t4g.small"
}

variable "engine_version" {
  description = "PostgreSQL engine version. Pinned at the major.minor.patch level so a new patch from AWS doesn't roll out without a deliberate Terraform change. Matches the docker-compose local Postgres so migrations behave identically dev / prod / laptop."
  type        = string
  default     = "15.6"
}

variable "multi_az" {
  description = "Provision a standby replica in a second AZ. `false` in dev (single-AZ is the cheap default; dev outages are dev-only); `true` in prod (one-AZ failure must not take customer bookings down)."
  type        = bool
  default     = false
}

variable "allocated_storage" {
  description = "Initial allocated storage in GiB. MVP marketplace volumes (a few thousand bookings + small media-metadata rows) sit comfortably under 20 GiB for dev and 100 GiB for prod; autoscaling via `max_allocated_storage` absorbs growth without a manual change."
  type        = number
  default     = 20
}

variable "max_allocated_storage" {
  description = "Upper bound for RDS storage autoscaling. Set to `0` to disable autoscaling (AWS treats anything `<= allocated_storage` as disabled). Default `100` for dev, `1000` for prod when overridden."
  type        = number
  default     = 100
}

variable "backup_retention_days" {
  description = "Automated backup retention. MVP defaults: 7 days dev, 35 days prod (the AWS maximum)."
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retention_days >= 1 && var.backup_retention_days <= 35
    error_message = "backup_retention_days must be between 1 and 35 (RDS limit)."
  }
}

variable "backup_window" {
  description = "Daily automated backup window in `hh24:mi-hh24:mi` UTC format. Default 22:00-23:00 UTC (= 01:00-02:00 Addis Ababa, deep nighttime for the target market)."
  type        = string
  default     = "22:00-23:00"
}

variable "maintenance_window" {
  description = "Weekly maintenance window in `ddd:hh24:mi-ddd:hh24:mi` UTC format. Default Sunday 23:00-Monday 00:00 UTC."
  type        = string
  default     = "sun:23:00-mon:00:00"
}

variable "master_username" {
  description = "Master Postgres username. The application connects with this user via the password stored in Secrets Manager; the migration runner reuses it for DDL."
  type        = string
  default     = "ethiolink"
}

variable "db_name" {
  description = "Initial database name created on the instance. Matches the docker-compose local database so connection strings have the same `?database=...` shape across environments."
  type        = string
  default     = "ethiolink"
}

variable "enable_rds_proxy" {
  description = "Provision an RDS Proxy in front of the instance. `false` in dev (Lambda concurrency in dev is too low to justify the proxy cost); `true` in prod (Lambda fan-out otherwise exhausts the DB connection pool). When enabled, the module also creates a proxy-specific security group + an ingress rule on `sg-rds` that allows the proxy to reach the DB."
  type        = bool
  default     = false
}

variable "rds_proxy_idle_client_timeout" {
  description = "RDS Proxy idle-client timeout in seconds. AWS default is 1800 (30min); we drop to 600 to recycle connections more aggressively given Lambda's bursty profile."
  type        = number
  default     = 600
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module. Merged with the per-resource Component / Module tags."
  type        = map(string)
  default     = {}
}

# -----------------------------------------------------------------------------
# Phase 9 Track 4 — KMS inputs.
#
# Both default to `null`, in which case the resources keep their
# AWS-managed encryption (`aws/rds` for the DB instance,
# `aws/secretsmanager` for the master secret). When set, the
# resources encrypt under the customer-managed KMS keys from the
# `kms` module. The env stack pipes `module.kms.rds_key_arn` +
# `module.kms.secrets_key_arn` here.
#
# **Important**: for an EXISTING instance, AWS does not support an
# in-place `kms_key_id` swap on `aws_db_instance`. Terraform reports
# the change as a "drift" but `terraform apply` will not move data
# — the operator must run the re-encryption runbook (snapshot copy
# with the new CMK, restore-from-snapshot, cutover) for existing
# data to actually re-encrypt. Setting `kms_key_id` here is
# sufficient for FRESH instances to launch under the CMK from day
# one.
# -----------------------------------------------------------------------------

variable "kms_key_id" {
  description = "ARN (or key id) of the customer-managed KMS key used to encrypt the DB instance's storage. `null` (the default) preserves AWS-managed `aws/rds` encryption. When set on a fresh instance the storage encrypts under the CMK on first launch; on an existing instance Terraform reports drift but cannot in-place re-encrypt — the re-encryption runbook (snapshot copy + restore) is the supported migration path."
  type        = string
  default     = null
}

variable "secrets_kms_key_id" {
  description = "ARN (or key id) of the customer-managed KMS key used to encrypt the `ethiolink/<environment>/rds/master` Secrets Manager secret. `null` (the default) preserves AWS-managed `aws/secretsmanager` encryption. Unlike RDS, Secrets Manager re-encrypts the secret value in place on the next version write — the runbook describes triggering one rotation post-CMK-flip to cycle existing versions onto the CMK."
  type        = string
  default     = null
}
