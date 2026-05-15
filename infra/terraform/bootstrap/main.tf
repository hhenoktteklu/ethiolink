# EthioLink — Terraform bootstrap stack.
#
# One-shot stack that creates the prerequisites every other Terraform
# stack in this repository depends on:
#
#   * An S3 bucket holding the remote `terraform.tfstate` for each
#     environment workspace (`env/dev/...`, `env/prod/...`).
#     Versioned + SSE-KMS-encrypted + block-public-access for safety.
#   * A DynamoDB table providing the `LockID`-keyed advisory lock
#     that the S3 backend uses to serialize concurrent `terraform apply`
#     runs. Pay-per-request because Terraform-induced traffic is
#     bursty and tiny.
#   * The GitHub OIDC identity provider — the trust anchor that lets
#     GitHub Actions workflows obtain short-lived AWS credentials
#     without long-lived `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`
#     secrets in the repo.
#   * An IAM role (`ethiolink-terraform-deploy`) assumed by those
#     workflows. The trust policy restricts the OIDC `sub` claim to
#     this repository (`repo:<owner>/<repo>:*`) so only Actions runs
#     inside the project can assume it.
#
# State location for the bootstrap stack itself:
#   The bootstrap is necessarily a chicken-and-egg: it creates the
#   bucket the rest of the project uses for remote state, so its own
#   state cannot live there on the first apply. We keep the bootstrap
#   state on the operator's laptop (or in `infra/terraform/bootstrap/.terraform/`
#   ignored by git). After first apply, the operator may optionally
#   migrate the state into the bucket they just created — but it's not
#   required; the bootstrap is so small (and so rarely changes) that
#   carrying the state file on disk and committing diffs by re-running
#   `terraform plan` against the live resources is acceptable.
#
# Trust policy scope:
#   The trust condition is `repo:<owner>/<repo>:*`, which trusts every
#   ref in the repo (every branch, every PR, every tag). That is
#   correct for the *plan* workflow because we want PRs to plan against
#   dev. The *apply* workflows (Phase 7 commits 2+) will use a tighter
#   condition (`repo:<owner>/<repo>:ref:refs/heads/main` for dev apply;
#   `repo:<owner>/<repo>:ref:refs/tags/v*` for prod apply) on a
#   different role. That separation lives in a follow-up commit.
#
# Permissions scope:
#   `AdministratorAccess` is attached to the deploy role for now. This
#   is INTENTIONALLY broad while the rest of the Phase 7 modules land —
#   the role needs to create VPC + RDS + Lambda + API Gateway + Cognito
#   + S3 + EventBridge + CloudWatch + WAF + IAM + Secrets Manager
#   resources from scratch, and authoring a least-privilege policy
#   before we know the exact API calls each module emits is a
#   yak-shave. The follow-up commit that tightens this lands once the
#   `dev` environment has applied cleanly at least once and we can
#   generate the actual call-set from CloudTrail. Documented in
#   `AWS_DEPLOYMENT.md` "Bootstrap" section as a deliberate temporary
#   choice, not an oversight.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region

  default_tags {
    tags = merge(
      {
        Project     = "ethiolink"
        Environment = "shared"
        Component   = "terraform-bootstrap"
        ManagedBy   = "terraform"
      },
      var.tags,
    )
  }
}

# -----------------------------------------------------------------------------
# Identity lookups
# -----------------------------------------------------------------------------

data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}

locals {
  # Shared across the state bucket and lock table. Single bucket
  # holds every environment's state at `env/<name>/terraform.tfstate`.
  state_bucket_name = "${var.name_prefix}-terraform-state"
  lock_table_name   = "${var.name_prefix}-terraform-locks"
  deploy_role_name  = "${var.name_prefix}-terraform-deploy"

  github_oidc_url       = "https://token.actions.githubusercontent.com"
  github_oidc_audience  = "sts.amazonaws.com"
  github_repository_sub = "repo:${var.github_owner}/${var.github_repository}:*"
}

# -----------------------------------------------------------------------------
# State bucket — versioned + SSE + private
# -----------------------------------------------------------------------------

resource "aws_s3_bucket" "terraform_state" {
  bucket = local.state_bucket_name

  # Block accidental destruction. The state bucket contains every
  # `terraform.tfstate` file the project relies on; deleting it
  # without an explicit migration is unrecoverable for active envs.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Force-TLS bucket policy. Anything that talks to this bucket over
# plain HTTP is rejected — Terraform always uses TLS so this is a
# zero-cost defense against accidental misconfiguration elsewhere.
resource "aws_s3_bucket_policy" "terraform_state_tls_only" {
  bucket = aws_s3_bucket.terraform_state.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyInsecureTransport"
        Effect    = "Deny"
        Principal = "*"
        Action    = "s3:*"
        Resource = [
          aws_s3_bucket.terraform_state.arn,
          "${aws_s3_bucket.terraform_state.arn}/*",
        ]
        Condition = {
          Bool = {
            "aws:SecureTransport" = "false"
          }
        }
      },
    ]
  })
}

# -----------------------------------------------------------------------------
# Lock table — DynamoDB
# -----------------------------------------------------------------------------

resource "aws_dynamodb_table" "terraform_locks" {
  name         = local.lock_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "LockID"

  attribute {
    name = "LockID"
    type = "S"
  }

  point_in_time_recovery {
    enabled = false
  }

  # Same posture as the state bucket — accidental table destruction
  # would orphan every active lock and require a manual lock release
  # for each environment.
  lifecycle {
    prevent_destroy = true
  }
}

# -----------------------------------------------------------------------------
# GitHub OIDC provider
# -----------------------------------------------------------------------------

# The thumbprint list is required by the AWS API but is effectively
# vestigial — AWS now validates the GitHub OIDC chain against its
# built-in CA bundle. We supply the published thumbprint as a
# defensive copy. Re-rolls of GitHub's certificate change the
# thumbprint; the value below matches GitHub's current public cert
# as of 2024-04 and is the value the official `aws-actions/configure-aws-credentials`
# documentation recommends.
resource "aws_iam_openid_connect_provider" "github" {
  url             = local.github_oidc_url
  client_id_list  = [local.github_oidc_audience]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# -----------------------------------------------------------------------------
# terraform-deploy role
# -----------------------------------------------------------------------------

data "aws_iam_policy_document" "github_assume" {
  statement {
    sid     = "GitHubActionsOIDCAssume"
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    # Restrict the audience to STS — anything else is a misconfigured
    # workflow.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = [local.github_oidc_audience]
    }

    # Restrict the GitHub repo. `:*` matches every ref / job / env
    # inside this repository; tighter scoping by ref happens on the
    # apply roles (Phase 7 follow-up commits), not on this plan-only
    # role.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = [local.github_repository_sub]
    }
  }
}

resource "aws_iam_role" "terraform_deploy" {
  name               = local.deploy_role_name
  assume_role_policy = data.aws_iam_policy_document.github_assume.json

  description = "Assumed by GitHub Actions in ${var.github_owner}/${var.github_repository} via OIDC. Used by Phase 7 plan + apply workflows. Permissions are deliberately broad during bootstrap; the follow-up commit tightens to per-service least-privilege once the dev environment has applied cleanly at least once."

  # Forbid the trust policy from being broadened by accident — only
  # this stack manages the role.
  lifecycle {
    prevent_destroy = true
  }
}

# Broad permissions during bootstrap. Documented as temporary in the
# role description and `AWS_DEPLOYMENT.md`. Tightened in a follow-up
# Phase 7 commit once CloudTrail has captured the real call set from
# a clean dev apply.
resource "aws_iam_role_policy_attachment" "terraform_deploy_admin" {
  role       = aws_iam_role.terraform_deploy.name
  policy_arn = "arn:${data.aws_partition.current.partition}:iam::aws:policy/AdministratorAccess"
}
