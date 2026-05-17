# EthioLink — RDS module.
#
# Provisions:
#
#   * A `aws_db_subnet_group` spanning the VPC's private subnets.
#   * A `aws_db_parameter_group` family-15 (no overrides today;
#     extending it is a follow-up commit alongside the first real
#     `pg_stat_statements` / `log_min_duration_statement` ask).
#   * A `aws_db_instance` running PostgreSQL 15 with storage
#     encryption + automated backups + deletion protection +
#     final snapshot on accidental tear-down.
#   * The master password as a `random_password` resource
#     piped into a `aws_secretsmanager_secret` + `aws_secretsmanager_secret_version`
#     under the stable name `ethiolink/${environment}/rds/master`.
#     The secret JSON shape matches what AWS's built-in RDS
#     rotation Lambdas expect (`{ username, password, engine,
#     host, port, dbname, dbInstanceIdentifier }`), so a future
#     rotation wiring drops in without a value-shape change.
#   * Optionally (when `var.enable_rds_proxy = true`): an RDS Proxy
#     with its own security group + IAM role + secret read
#     permission. The proxy SG is the surface Lambdas connect to
#     in prod; `sg-rds` accepts ingress from the proxy SG (via an
#     extra ingress rule created inside this module so the VPC
#     module stays oblivious to whether the proxy is enabled).
#
# Mutation safety:
#   - `prevent_destroy = true` on the DB instance and the Secrets
#     Manager secret. A `terraform destroy` cannot tear either down.
#   - `deletion_protection = true` on the DB instance — required
#     even when `prevent_destroy` is the Terraform-side guard,
#     because operator-driven `aws rds delete-db-instance` calls
#     also need a second confirmation.
#   - `skip_final_snapshot = false` + a stable
#     `final_snapshot_identifier`. If a future commit deliberately
#     destroys the instance, the snapshot is the recovery path.
#
# Connection strings:
#   - With proxy disabled (dev): app uses `db_endpoint` directly.
#   - With proxy enabled (prod): app uses `proxy_endpoint` —
#     transparent to the Postgres driver, same `pg`-compatible
#     wire protocol.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.5"
    }
  }
}

locals {
  base_name = "${var.name_prefix}-${var.environment}"

  instance_identifier = "${local.base_name}-rds"
  parameter_group     = "${local.base_name}-rds-pg15"
  subnet_group        = "${local.base_name}-rds-subnets"
  proxy_name          = "${local.base_name}-rds-proxy"
  proxy_sg_name       = "${local.base_name}-sg-rds-proxy"
  proxy_role_name     = "${local.base_name}-rds-proxy-role"

  secret_name = "ethiolink/${var.environment}/rds/master"

  common_tags = merge(
    {
      Component = "rds"
      Module    = "rds"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# Subnet + parameter groups
# -----------------------------------------------------------------------------

resource "aws_db_subnet_group" "this" {
  name        = local.subnet_group
  subnet_ids  = var.private_subnet_ids
  # AWS rejects non-printable + extended-unicode chars in this
  # description ("InvalidParameterValue: DBSubnetGroupDescription
  # must not contain non-printable control characters"). Stick to
  # plain 7-bit ASCII.
  description = "EthioLink ${var.environment} RDS private subnet group spanning ${length(var.private_subnet_ids)} AZs."

  tags = merge(local.common_tags, {
    Name = local.subnet_group
  })
}

resource "aws_db_parameter_group" "this" {
  name        = local.parameter_group
  family      = "postgres15"
  # AWS rejects non-printable + extended-unicode chars in this
  # description ("InvalidParameterValue: DB parameter group
  # Description must not contain non-printable control
  # characters"). Stick to plain 7-bit ASCII.
  description = "EthioLink ${var.environment} PostgreSQL 15 parameter group with default settings."

  # No overrides in MVP. Phase 8 hardening adds `log_min_duration_statement`,
  # `pg_stat_statements.track`, and the `shared_preload_libraries` entry.

  tags = local.common_tags
}

# -----------------------------------------------------------------------------
# Master password — random + Secrets Manager
# -----------------------------------------------------------------------------

# Postgres-safe special character set: skip characters that need
# URL-escaping (`/`, `@`, `:`) or shell-escaping (`\`, `"`, `'`,
# space, backtick). The remaining set is plenty for entropy at
# length 32.
resource "random_password" "master" {
  length  = 32
  special = true
  override_special = "!#%&()*+,-.<=>?[]^_{|}~"
}

resource "aws_secretsmanager_secret" "master" {
  name        = local.secret_name
  description = "EthioLink ${var.environment} RDS master credentials. Read by Lambdas at cold-start via `loadSecretsThenConfig`."

  # Recovery window of 7 days lets an accidental deletion be
  # rolled back with `aws secretsmanager restore-secret`.
  recovery_window_in_days = 7

  # Phase 9 Track 4 — `null` keeps the AWS-managed
  # `aws/secretsmanager` key (the existing behavior); a non-null
  # value flips to the customer-managed CMK from the `kms` module.
  # New secret VERSIONS are immediately encrypted under the new
  # key; the existing version remains under the old key until the
  # next rotation cycles a fresh value.
  kms_key_id = var.secrets_kms_key_id

  tags = local.common_tags

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret_version" "master" {
  secret_id = aws_secretsmanager_secret.master.id

  # JSON shape compatible with the AWS-provided RDS rotation Lambdas
  # and with RDS Proxy's `auth.secret_arn`. The same shape is what
  # `backend/shared/config/loadConfig.ts` expects when its future
  # `loadSecretsThenConfig` shim parses the resolved secret value.
  secret_string = jsonencode({
    username             = var.master_username
    password             = random_password.master.result
    engine               = "postgres"
    host                 = aws_db_instance.this.address
    port                 = aws_db_instance.this.port
    dbname               = var.db_name
    dbInstanceIdentifier = aws_db_instance.this.identifier
  })
}

# -----------------------------------------------------------------------------
# DB instance
# -----------------------------------------------------------------------------

resource "aws_db_instance" "this" {
  identifier = local.instance_identifier

  engine                      = "postgres"
  engine_version              = var.engine_version
  instance_class              = var.instance_class
  allocated_storage           = var.allocated_storage
  max_allocated_storage       = var.max_allocated_storage > var.allocated_storage ? var.max_allocated_storage : 0
  storage_type                = "gp3"
  storage_encrypted           = true

  # Phase 9 Track 4 — `null` keeps the AWS-managed `aws/rds` key
  # (existing behavior); a non-null value tells RDS to launch fresh
  # instances + provision automated snapshots under the customer-
  # managed CMK from the `kms` module. AWS rejects an in-place key
  # swap on an existing instance — for already-launched instances
  # this argument just records the intended key; the re-encryption
  # runbook (snapshot copy + restore) is the supported migration
  # path. New automated snapshots taken after the instance is on
  # the CMK are encrypted under it.
  kms_key_id = var.kms_key_id

  db_name  = var.db_name
  username = var.master_username
  password = random_password.master.result

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.rds_security_group_id]
  parameter_group_name   = aws_db_parameter_group.this.name

  multi_az                = var.multi_az
  publicly_accessible     = false
  port                    = 5432

  backup_retention_period = var.backup_retention_days
  backup_window           = var.backup_window
  maintenance_window      = var.maintenance_window

  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.instance_identifier}-final"
  copy_tags_to_snapshot     = true

  # Apply non-immediate changes inside the maintenance window so a
  # production parameter-group bump doesn't cause a surprise
  # restart in the middle of business hours.
  apply_immediately = false

  # Patch versions auto-apply during the maintenance window; major
  # version bumps remain manual (require a deliberate `engine_version`
  # change).
  auto_minor_version_upgrade = true

  performance_insights_enabled = true
  performance_insights_retention_period = 7

  enabled_cloudwatch_logs_exports = ["postgresql"]

  tags = merge(local.common_tags, {
    Name = local.instance_identifier
  })

  lifecycle {
    prevent_destroy = true

    # The instance is initialized with the freshly-generated random
    # password, then the secret-version above publishes the same
    # value. `password` is the master-password field — it shouldn't
    # be set to anything from a later refresh.
    ignore_changes = [password]
  }
}

# -----------------------------------------------------------------------------
# RDS Proxy (prod only when `enable_rds_proxy = true`)
# -----------------------------------------------------------------------------

# Dedicated SG for the proxy. The proxy accepts inbound from the
# Lambda SG (mirroring the direct-to-RDS posture); the existing
# `sg-rds` group gains a new ingress rule from this SG below so
# the proxy can reach the DB.
resource "aws_security_group" "proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  name        = local.proxy_sg_name
  description = "EthioLink ${var.environment} RDS Proxy. Ingress from Lambda SG; egress to RDS SG."
  vpc_id      = var.vpc_id

  tags = merge(local.common_tags, {
    Name = local.proxy_sg_name
  })
}

# Allow Lambdas to reach the proxy. The Lambda SG id isn't passed
# in as a separate var to keep the module's surface small;
# instead, we read it via the existing `rds_security_group_id`
# ingress rules… but those live on `sg-rds`, not on the proxy SG.
# The clean fix is to require the lambda SG explicitly. We do that
# via the egress side: the proxy SG accepts inbound from anything
# in the VPC that's allowed to talk to `sg-rds`, achieved by
# referencing `var.rds_security_group_id` as the source — every
# Lambda allowed to call RDS is therefore also allowed to call the
# proxy, without leaking knowledge of Lambda SG into this module.
#
# We additionally require the proxy SG to receive traffic from the
# RDS SG members. AWS treats this as a same-VPC SG reference; it
# tightens the surface to "only things the VPC module sanctioned
# can reach DB" without enumerating them.
resource "aws_vpc_security_group_ingress_rule" "proxy_from_lambda_via_rds_sg" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = aws_security_group.proxy[0].id
  description                  = "Postgres from anyone in the RDS-trusted set (Lambdas, bastion)."
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.rds_security_group_id
}

resource "aws_vpc_security_group_egress_rule" "proxy_to_rds" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = aws_security_group.proxy[0].id
  description                  = "Postgres to RDS instance SG."
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = var.rds_security_group_id
}

# RDS SG accepts inbound from the proxy SG on 5432 so the proxy
# can reach the instance. The VPC module doesn't know about the
# proxy — we add the rule here from the RDS module's vantage point.
resource "aws_vpc_security_group_ingress_rule" "rds_from_proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  security_group_id            = var.rds_security_group_id
  description                  = "Postgres from RDS Proxy SG."
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.proxy[0].id
}

# IAM role assumed by the proxy. Scoped to read the master secret
# only.
data "aws_iam_policy_document" "proxy_assume" {
  count = var.enable_rds_proxy ? 1 : 0

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["rds.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "proxy" {
  count = var.enable_rds_proxy ? 1 : 0

  name               = local.proxy_role_name
  assume_role_policy = data.aws_iam_policy_document.proxy_assume[0].json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "proxy_read_secret" {
  count = var.enable_rds_proxy ? 1 : 0

  statement {
    effect = "Allow"

    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]

    resources = [aws_secretsmanager_secret.master.arn]
  }
}

resource "aws_iam_role_policy" "proxy_read_secret" {
  count = var.enable_rds_proxy ? 1 : 0

  name   = "${local.proxy_role_name}-read-secret"
  role   = aws_iam_role.proxy[0].id
  policy = data.aws_iam_policy_document.proxy_read_secret[0].json
}

resource "aws_db_proxy" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  name                   = local.proxy_name
  engine_family          = "POSTGRESQL"
  role_arn               = aws_iam_role.proxy[0].arn
  vpc_subnet_ids         = var.private_subnet_ids
  vpc_security_group_ids = [aws_security_group.proxy[0].id]

  require_tls            = true
  idle_client_timeout    = var.rds_proxy_idle_client_timeout
  debug_logging          = false

  auth {
    auth_scheme = "SECRETS"
    iam_auth    = "DISABLED"
    secret_arn  = aws_secretsmanager_secret.master.arn
  }

  tags = merge(local.common_tags, {
    Name = local.proxy_name
  })

  # The secret-version is what actually carries the password; the
  # proxy fails to authenticate against the DB until it lands.
  depends_on = [aws_secretsmanager_secret_version.master]
}

resource "aws_db_proxy_default_target_group" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  db_proxy_name = aws_db_proxy.this[0].name

  connection_pool_config {
    # Cap per-target connections at 90% of the instance's
    # `max_connections` (AWS default is 100, so cap at 90 here).
    # Tune after first load test.
    max_connections_percent      = 90
    max_idle_connections_percent = 50
    connection_borrow_timeout    = 120
  }
}

resource "aws_db_proxy_target" "this" {
  count = var.enable_rds_proxy ? 1 : 0

  db_proxy_name          = aws_db_proxy.this[0].name
  target_group_name      = aws_db_proxy_default_target_group.this[0].name
  db_instance_identifier = aws_db_instance.this.identifier
}
