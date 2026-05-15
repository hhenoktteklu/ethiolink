# EthioLink — VPC module outputs.
#
# Stable identifiers consumed by every other Phase 7 module:
#
#   * `rds` reads `vpc_id`, `private_subnet_ids`, and
#     `rds_security_group_id` for its subnet group + DB instance.
#   * `lambda` reads `private_subnet_ids` and
#     `lambda_security_group_id` for the per-function VPC config.
#   * `api-gateway` does not need VPC outputs (REST API lives at
#     the AWS edge, not in the VPC) — but future private API or
#     VPC-link work would consume `vpc_id` + a subnet list.
#   * `admin-frontend` does not need VPC outputs either; CloudFront
#     + S3 are public-internet-facing services.
#
# All values are bare identifiers / lists — no nested objects —
# so downstream module inputs can reference them directly without
# `.id` indirection.

output "vpc_id" {
  description = "VPC id for the environment."
  value       = aws_vpc.this.id
}

output "vpc_cidr" {
  description = "CIDR block of the VPC. Useful for future peering / TGW configurations and for documenting in alerts."
  value       = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  description = "IDs of the public subnets, ordered to match `availability_zones`. The NAT Gateway(s), the future bastion EC2 host, and any other internet-facing resources live in these subnets."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "IDs of the private subnets, ordered to match `availability_zones`. Lambdas, RDS, and any other VPC-resident workload live here."
  value       = aws_subnet.private[*].id
}

output "availability_zones" {
  description = "Availability zone names the VPC spans, ordered to match the subnet lists."
  value       = local.azs
}

output "lambda_security_group_id" {
  description = "Security group attached to every EthioLink Lambda. Egress-only — Lambdas don't accept inbound TCP."
  value       = aws_security_group.lambda.id
}

output "rds_security_group_id" {
  description = "Security group attached to the RDS instance. Ingress on Postgres port from the Lambda SG (and, when present, the bastion SG)."
  value       = aws_security_group.rds.id
}

output "bastion_security_group_id" {
  description = "Security group for the operator bastion. `null` when `enable_bastion_sg = false` (the default in dev). Prod sets the flag to true so the SG exists ahead of any actual bastion EC2 launch."
  value       = var.enable_bastion_sg ? aws_security_group.bastion[0].id : null
}
