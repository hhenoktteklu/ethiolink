# Phase 7 — AWS Deployment

## Goal

Move from "runs in dev" to "ships repeatably to prod". Terraform end-to-end for dev and prod, GitHub Actions CI/CD with OIDC, and CloudWatch dashboards and alarms for the critical signals.

## Scope

In scope:

- Terraform modules for all production resources: VPC, RDS, Cognito, S3, API Gateway, Lambda, EventBridge, CloudWatch, IAM.
- Two environment workspaces (`dev`, `prod`) with their own state and variable files.
- RDS Proxy in prod.
- WAF basic rule set in front of API Gateway (rate limit, AWS managed rules).
- GitHub Actions workflows:
  - `lint-test.yml` (PR)
  - `terraform-plan.yml` (PR touching `infra/`)
  - `deploy-dev.yml` (on push to `main`)
  - `deploy-prod.yml` (manual dispatch with release tag)
- CloudWatch dashboards for API, Lambda, RDS, S3.
- Alarms (with email subscription) for: API 5xx rate, Lambda error rate, RDS CPU and connections, RDS free storage, EventBridge invocation failures.
- Secrets stored in AWS Secrets Manager; Lambdas pull via SDK with caching.

Out of scope:

- Multi-region failover.

> Note: the original scope listed "CDN for the admin SPA" as out of scope, but the implementation pulled it in — Phase 7 now provisions S3 + CloudFront for the admin SPA via `infra/terraform/modules/admin-frontend/`. See `docs/architecture/AWS_DEPLOYMENT.md` "Admin frontend".

## Files involved

- `infra/terraform/modules/{vpc,rds,api-gateway,lambda,s3,cognito,eventbridge,cloudwatch,waf,iam}/*`
- `infra/terraform/environments/{dev,prod}/{main.tf,variables.tf,outputs.tf,backend.tf,terraform.tfvars}`
- `.github/workflows/{lint-test.yml,terraform-plan.yml,deploy-dev.yml,deploy-prod.yml}`
- `backend/scripts/{build.sh,package.sh,deploy.sh}`
- `docs/architecture/AWS_DEPLOYMENT.md` (update with final resource map)

## Checklist

- [ ] Dev environment provisioned end-to-end from a clean Terraform state.
- [ ] Prod environment provisioned with Multi-AZ RDS, RDS Proxy, WAF.
- [ ] GitHub Actions OIDC role assumes a least-privilege Terraform role.
- [ ] `deploy-dev.yml` deploys Lambdas and runs a smoke test on push to `main`.
- [ ] `deploy-prod.yml` requires manual approval and a `vX.Y.Z` tag.
- [ ] CloudWatch dashboards exist for the four resource groups.
- [ ] Alarms send to a verified SNS topic with an on-call email.

## Acceptance criteria

- A fresh `terraform apply` of the dev environment from scratch produces a working API.
- A merge to `main` results in updated Lambdas in dev and a passing smoke test.
- A prod deploy can be performed by tag without bypassing the approval gate.
- All Lambda environment variables that contain secrets are sourced from Secrets Manager (not Terraform vars).

## Test plan

- Apply dev from scratch in a sandbox AWS account; verify all resources come up healthy.
- Trigger each alarm intentionally (e.g., force a Lambda error) and confirm SNS delivery.
- Run a load test against dev: 50 RPS on `GET /v1/businesses` for 10 minutes, observe p95 latency and error rate.

## Rollback notes

- Terraform plans are reviewed in PR; destructive changes (e.g., RDS replacement) require explicit approval in the PR description.
- Lambda deploys keep the previous version; rollback is publishing the previous alias.
- If a prod deploy goes wrong, the manual `deploy-prod.yml` can be re-run with the prior tag.
