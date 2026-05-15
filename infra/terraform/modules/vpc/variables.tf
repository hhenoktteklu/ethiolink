# EthioLink — VPC module inputs.
#
# This module provisions one VPC per environment plus the security
# groups every other Phase 7 module consumes (`lambda`, `rds`, and
# the optional prod `bastion`). Defaults are chosen so a clean
# apply works for dev with no per-call overrides.

variable "environment" {
  description = "Deployment environment name (e.g. \"dev\", \"prod\"). Used in resource names and tags."
  type        = string

  validation {
    condition     = contains(["dev", "staging", "prod"], var.environment)
    error_message = "environment must be one of: dev, staging, prod."
  }
}

variable "name_prefix" {
  description = "Resource name prefix. Defaults to \"ethiolink\". Combined with environment to form names like \"ethiolink-dev-vpc\"."
  type        = string
  default     = "ethiolink"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC. Each environment gets a non-overlapping range so future VPC peering / Transit Gateway wiring doesn't need to renumber: dev `10.0.0.0/16`, prod `10.1.0.0/16`. The module carves the supplied range into four /24 subnets per AZ — two public, two private — leaving 240+ unused /24 slots for future tiers (cache subnet group, transit subnets, etc.)."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR block (e.g. 10.0.0.0/16)."
  }
}

variable "az_count" {
  description = "Number of availability zones to span. Two AZs is the MVP default for both dev (single-AZ RDS but still spread the Lambdas) and prod (Multi-AZ RDS + per-AZ NAT). Three is a future option once we revisit cost vs. resilience."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count must be 2 or 3."
  }
}

variable "nat_gateway_count" {
  description = "Number of NAT Gateways. Dev uses 1 (single-AZ — cheaper, acceptable because dev outages are dev-only); prod uses one per AZ (=az_count) so a single-AZ outage doesn't strand Lambdas in the surviving AZ without egress."
  type        = number
  default     = 1

  validation {
    condition     = var.nat_gateway_count >= 1
    error_message = "nat_gateway_count must be at least 1."
  }
}

variable "enable_bastion_sg" {
  description = "Create an SSH bastion security group. Prod only — provides a controlled entry point for one-off operator access to RDS / Lambda VPCs. The SG is created with no associated instance; standing up the bastion EC2 instance is a separate manual step gated by a real on-call need."
  type        = bool
  default     = false
}

variable "bastion_allowed_cidrs" {
  description = "CIDR blocks allowed to SSH to the bastion security group on port 22. Empty list (default) creates the SG with no ingress — the operator adds their own IP via an out-of-band rule when bastion access is actually needed, rather than hardcoding an office IP into Terraform. Only honored when `enable_bastion_sg = true`."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional tags applied to every resource created by this module. Merged with the per-resource Component / Module tags."
  type        = map(string)
  default     = {}
}
