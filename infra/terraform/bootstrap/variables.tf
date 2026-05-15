# EthioLink — Terraform bootstrap inputs.
#
# This stack is the one-shot bootstrap that creates the S3 + DynamoDB
# backend used by every subsequent environment ("dev", "prod", future
# "staging"), plus the GitHub OIDC plumbing that lets CI assume an
# AWS role without long-lived access keys.
#
# Defaults are chosen so a clean `terraform apply` from a fresh
# checkout works without a `terraform.tfvars` file. Override only
# when forking the project under a different name / region / GitHub
# org.

variable "region" {
  description = "AWS region for the state bucket, lock table, and IAM resources. The IAM resources are global but the provider region is required."
  type        = string
  default     = "eu-west-1"
}

variable "name_prefix" {
  description = "Resource name prefix. Combined with fixed suffixes to form the state bucket name, lock table name, and role name. Defaults to \"ethiolink\". Must be globally unique enough for an S3 bucket (S3 namespaces every bucket globally)."
  type        = string
  default     = "ethiolink"
}

variable "github_owner" {
  description = "GitHub organization / user that owns the repository whose Actions workflows are trusted to assume the deploy role."
  type        = string
  default     = "hhenoktteklu"
}

variable "github_repository" {
  description = "GitHub repository name (without the owner prefix). Combined with `github_owner` to form the OIDC `sub` claim filter `repo:<owner>/<repo>:*`."
  type        = string
  default     = "ethiolink"
}

variable "tags" {
  description = "Additional tags applied to every resource created by the bootstrap stack. Merged with the per-resource Component / Module tags."
  type        = map(string)
  default     = {}
}
