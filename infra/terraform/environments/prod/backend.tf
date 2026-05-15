# EthioLink — prod remote state backend.
#
# Points the prod workspace at the shared S3 + DynamoDB backend
# provisioned by `infra/terraform/bootstrap/`. Identical shape to
# `dev/backend.tf` — the only difference is the `key` path so each
# environment writes to its own state file inside the shared bucket.
#
# Phase 7's prod modules don't land in this commit — the prod
# `main.tf` is still the Phase 0 stub. Wiring the backend now
# means that when those modules arrive, `terraform init` Just Works
# with no separate "configure remote state for prod" follow-up.
#
# See `docs/architecture/AWS_DEPLOYMENT.md` "Bootstrap" for the
# one-time setup procedure that creates the bucket + lock table
# this file references.

terraform {
  backend "s3" {
    bucket         = "ethiolink-terraform-state"
    key            = "env/prod/terraform.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "ethiolink-terraform-locks"
    encrypt        = true
  }
}
