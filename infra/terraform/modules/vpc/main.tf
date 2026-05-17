# EthioLink — VPC module.
#
# Provisions one VPC per environment plus the security groups every
# other Phase 7 module depends on. Topology:
#
#   * 1 VPC.
#   * `az_count` (default 2) availability zones drawn from the
#     region's `aws_availability_zones` data source.
#   * Two subnets per AZ — one public, one private. Subnets are
#     carved deterministically from `var.vpc_cidr` via `cidrsubnet`:
#
#         public[i]  → cidrsubnet(vpc_cidr, 8, i)        → 10.x.0.0/24, 10.x.1.0/24, ...
#         private[i] → cidrsubnet(vpc_cidr, 8, 10 + i)   → 10.x.10.0/24, 10.x.11.0/24, ...
#
#     The 10-slot gap between public and private leaves room for
#     additional tiers (a dedicated DB subnet group at indexes 20+,
#     a cache group at 30+, etc.) without renumbering.
#   * 1 Internet Gateway on the VPC. Public subnets route default
#     traffic to it.
#   * `nat_gateway_count` NAT Gateways in the public subnets. Dev
#     uses 1 (single-AZ — cheaper, acceptable for dev outages);
#     prod uses one per AZ so a single-AZ outage doesn't strand
#     Lambdas in the surviving AZ without egress. Each private
#     subnet's route table points at the NAT in its AZ when prod
#     wires per-AZ NATs; the dev single-NAT case routes every
#     private subnet at the lone NAT.
#   * Three security groups:
#       - `lambda` — egress-only. Lambdas in this SG can call out
#         to AWS endpoints (Secrets Manager, S3, etc. via VPC
#         endpoints if/when added, or the public internet via NAT).
#         No ingress — Lambdas accept invocations from API Gateway
#         and EventBridge, neither of which uses VPC networking
#         for the inbound path.
#       - `rds` — ingress on TCP 5432 from the `lambda` SG only.
#         No public exposure. The cross-SG reference (rather than
#         a hardcoded CIDR) makes the dependency intent explicit
#         and survives subnet renumbering.
#       - `bastion` (optional, prod-only) — ingress on TCP 22 from
#         the operator-supplied CIDR list. Created with no associated
#         instance; standing up the bastion EC2 host is a separate,
#         on-demand step.
#
# This module does NOT create:
#   * VPC endpoints. S3 + Secrets Manager VPC endpoints land in a
#     follow-up commit once we measure the NAT egress cost from a
#     real workload.
#   * Flow logs. Phase 8 hardening concern.
#   * NACLs beyond the AWS default. We rely on security groups for
#     access control; NACLs are a defense-in-depth knob that can
#     land later without a topology change.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  base_name = "${var.name_prefix}-${var.environment}"

  common_tags = merge(
    {
      Component = "vpc"
      Module    = "vpc"
    },
    var.tags,
  )
}

# -----------------------------------------------------------------------------
# Availability zone selection
# -----------------------------------------------------------------------------

data "aws_availability_zones" "available" {
  state = "available"

  # Default exclusions keep AWS-reserved AZs (e.g. local zones,
  # wavelength zones) out of the candidate list.
  filter {
    name   = "opt-in-status"
    values = ["opt-in-not-required"]
  }
}

locals {
  azs = slice(data.aws_availability_zones.available.names, 0, var.az_count)

  # Deterministic CIDR carve-outs. See module header.
  public_subnet_cidrs  = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, i)]
  private_subnet_cidrs = [for i in range(var.az_count) : cidrsubnet(var.vpc_cidr, 8, 10 + i)]
}

# -----------------------------------------------------------------------------
# VPC + IGW
# -----------------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block = var.vpc_cidr

  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-vpc"
  })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-igw"
  })
}

# -----------------------------------------------------------------------------
# Subnets
# -----------------------------------------------------------------------------

resource "aws_subnet" "public" {
  count = var.az_count

  vpc_id                  = aws_vpc.this.id
  availability_zone       = local.azs[count.index]
  cidr_block              = local.public_subnet_cidrs[count.index]
  map_public_ip_on_launch = true

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-public-${local.azs[count.index]}"
    Tier = "public"
  })
}

resource "aws_subnet" "private" {
  count = var.az_count

  vpc_id            = aws_vpc.this.id
  availability_zone = local.azs[count.index]
  cidr_block        = local.private_subnet_cidrs[count.index]

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-private-${local.azs[count.index]}"
    Tier = "private"
  })
}

# -----------------------------------------------------------------------------
# NAT Gateways
# -----------------------------------------------------------------------------

resource "aws_eip" "nat" {
  count = var.nat_gateway_count

  domain = "vpc"

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-nat-eip-${count.index}"
  })

  # NAT EIPs cost money even when unused; recreating them is fine.
  # Public subnets must exist before the EIP is allocated so the
  # implicit dependency through `aws_nat_gateway.this` is sufficient.
}

resource "aws_nat_gateway" "this" {
  count = var.nat_gateway_count

  # Place each NAT in a different public subnet, cycling through
  # the AZ list. With nat_gateway_count = 1 (dev), NAT lives in
  # public[0]; with nat_gateway_count = az_count (prod), one NAT
  # per public subnet.
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index % var.az_count].id

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-nat-${count.index}"
  })

  # NAT Gateway creation depends on the IGW being attached to the
  # VPC (so the NAT can reach the internet). Terraform infers this
  # via the subnet → VPC chain, but the explicit depends_on
  # eliminates a known eventual-consistency race on first apply.
  depends_on = [aws_internet_gateway.this]
}

# -----------------------------------------------------------------------------
# Route tables
# -----------------------------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-public-rt"
    Tier = "public"
  })
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count = var.az_count

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# One private route table per AZ. When `nat_gateway_count = 1`
# (dev), every private RT points at the single NAT. When
# `nat_gateway_count = az_count` (prod), each RT points at the
# NAT in its own AZ — preserves egress during a single-AZ NAT
# outage.
resource "aws_route_table" "private" {
  count = var.az_count

  vpc_id = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-private-rt-${local.azs[count.index]}"
    Tier = "private"
  })
}

resource "aws_route" "private_default" {
  count = var.az_count

  route_table_id         = aws_route_table.private[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  # Index into the NAT list: in the per-AZ-NAT case we hit the
  # AZ-matched NAT directly; in the single-NAT case the modulo
  # collapses every private RT to NAT 0.
  nat_gateway_id = aws_nat_gateway.this[count.index % var.nat_gateway_count].id
}

resource "aws_route_table_association" "private" {
  count = var.az_count

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# -----------------------------------------------------------------------------
# Security groups
# -----------------------------------------------------------------------------

# Lambda SG. No ingress — Lambdas don't accept inbound TCP. Egress
# is allow-all so the function can reach RDS (controlled by the
# RDS SG's ingress rule below), Secrets Manager, S3, and any VPC
# endpoints we add later.
resource "aws_security_group" "lambda" {
  name        = "${local.base_name}-sg-lambda"
  description = "EthioLink Lambdas in ${var.environment}. Egress-only."
  vpc_id      = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-sg-lambda"
  })
}

resource "aws_vpc_security_group_egress_rule" "lambda_egress_all" {
  security_group_id = aws_security_group.lambda.id
  # AWS restricts rule descriptions to characters in the set
  # a-zA-Z0-9. _-:/()#,@[]+=&;{}!$* — apostrophes and unicode are
  # rejected with "Invalid rule description". Keep this string in
  # the allowed alphabet.
  description = "Allow Lambda egress anywhere. Targets control ingress on their own SG."
  ip_protocol = "-1"
  cidr_ipv4   = "0.0.0.0/0"
}

# RDS SG. Ingress only from Lambda SG on Postgres port. The
# cross-SG reference makes the dependency intent explicit:
# "Lambdas in this VPC may connect to Postgres" — surviving any
# future subnet renumbering or CIDR change.
resource "aws_security_group" "rds" {
  name        = "${local.base_name}-sg-rds"
  description = "EthioLink RDS PostgreSQL in ${var.environment}. Ingress from Lambda SG only."
  vpc_id      = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-sg-rds"
  })
}

resource "aws_vpc_security_group_ingress_rule" "rds_from_lambda" {
  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from Lambda SG."
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.lambda.id
}

# Optional bastion SG (prod). Created only when
# `enable_bastion_sg = true`. Ingress on TCP 22 from caller-supplied
# CIDRs (empty by default — operator adds their own IP out-of-band
# rather than hardcoding an office IP here).
resource "aws_security_group" "bastion" {
  count = var.enable_bastion_sg ? 1 : 0

  name        = "${local.base_name}-sg-bastion"
  description = "EthioLink operator bastion in ${var.environment}. Ingress from operator-supplied CIDRs only."
  vpc_id      = aws_vpc.this.id

  tags = merge(local.common_tags, {
    Name = "${local.base_name}-sg-bastion"
  })
}

resource "aws_vpc_security_group_ingress_rule" "bastion_ssh" {
  count = var.enable_bastion_sg ? length(var.bastion_allowed_cidrs) : 0

  security_group_id = aws_security_group.bastion[0].id
  description       = "SSH from operator CIDR."
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.bastion_allowed_cidrs[count.index]
}

resource "aws_vpc_security_group_egress_rule" "bastion_egress_all" {
  count = var.enable_bastion_sg ? 1 : 0

  security_group_id = aws_security_group.bastion[0].id
  description       = "Allow bastion outbound to anywhere."
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# Allow the bastion to reach RDS on 5432 when present. Only
# created alongside the bastion SG; the rule references both SGs
# and lives on `sg-rds` because that's where ingress lives.
resource "aws_vpc_security_group_ingress_rule" "rds_from_bastion" {
  count = var.enable_bastion_sg ? 1 : 0

  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL from bastion SG."
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.bastion[0].id
}
