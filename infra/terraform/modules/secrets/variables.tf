# EthioLink — Secrets rotation module inputs.
#
# Wires the AWS-provided PostgreSQL single-user rotation Lambda
# to the RDS master secret created in the `rds` module. The
# rotation Lambda runs in the same VPC + security group as the
# application Lambdas because it has to reach RDS over the
# Postgres wire to `ALTER USER` the password.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in resource names + tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form the rotation Lambda name (`ethiolink-${env}-rds-rotation`)."
  type        = string
  default     = "ethiolink"
}

variable "region" {
  description = "AWS region. Threaded into the rotation Lambda's `endpoint` parameter so it calls the regional Secrets Manager endpoint instead of the default."
  type        = string
  default     = "eu-west-1"
}

variable "rds_master_secret_arn" {
  description = "ARN of the Secrets Manager secret carrying the RDS master credentials. Sourced from `module.rds.master_secret_arn`. The rotation rotates THIS secret's value every `rotation_days`."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet ids the rotation Lambda runs in. Same subnets as the application Lambdas — RDS lives there and the rotation Lambda needs Postgres-wire access to `ALTER USER`."
  type        = list(string)
}

variable "lambda_security_group_id" {
  description = "Security group attached to the rotation Lambda. Reusing `sg-lambda` is correct — the existing `sg-rds` ingress rule already allows TCP 5432 from this SG, which is exactly the access the rotation Lambda needs."
  type        = string
}

variable "rotation_days" {
  description = "Days between automatic rotations. AWS recommends 30 for production DB passwords; the AWS-managed rotation Lambda runs the four-step `createSecret` / `setSecret` / `testSecret` / `finishSecret` sequence transparently. Application Lambdas' warm containers may briefly hold the previous password — cold starts pick up the rotated value automatically because `loadSecretsThenConfig` re-resolves on each cold start."
  type        = number
  default     = 30

  validation {
    condition     = var.rotation_days >= 1 && var.rotation_days <= 365
    error_message = "rotation_days must be between 1 and 365."
  }
}

variable "enabled" {
  description = "Whether rotation is provisioned at all. `true` in both dev and prod by default; `false` is the disable knob for an environment where the operator temporarily wants to halt rotation while debugging an upstream issue."
  type        = bool
  default     = true
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module."
  type        = map(string)
  default     = {}
}
