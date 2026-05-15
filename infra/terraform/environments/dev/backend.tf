# EthioLink — dev remote state backend.
#
# Points the dev workspace at the shared S3 + DynamoDB backend
# provisioned by `infra/terraform/bootstrap/`. The bootstrap stack
# MUST have been applied at least once before this file is usable;
# see `docs/architecture/AWS_DEPLOYMENT.md` "Bootstrap" for the
# one-time procedure.
#
# Layout convention: one bucket holds every environment's state at
# `env/<name>/terraform.tfstate`. The lock table is shared across
# environments — DynamoDB's `LockID` key already namespaces by
# bucket + key, so concurrent dev + prod applies cannot block each
# other.
#
# Why values are hardcoded here instead of `-backend-config=...`:
#   The bucket name is a fixed, public identifier of this project
#   (it's tied to `name_prefix = "ethiolink"` in the bootstrap).
#   Putting the value in this file means `terraform init` runs from
#   a clean checkout without an out-of-band wrapper script and the
#   PR plan workflow doesn't need backend-config secrets.

terraform {
  backend "s3" {
    bucket         = "ethiolink-terraform-state"
    key            = "env/dev/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "ethiolink-terraform-locks"
    encrypt        = true
  }
}
