# AWS Deployment

## Region

Primary region: `eu-west-1` (Ireland). This is the closest AWS region to Ethiopia with the full set of services we need and acceptable latency. Re-evaluate when AWS Cape Town (`af-south-1`) gains parity for Cognito and RDS Proxy.

## Bootstrap (one-time)

Before any per-environment stack can apply, the shared S3 backend, DynamoDB lock table, GitHub OIDC provider, and `terraform-deploy` IAM role must exist. These four resources live in `infra/terraform/bootstrap/` and are created exactly once per AWS account by an operator from their laptop. After that, every other apply runs from CI against the remote state this bootstrap created.

### What it provisions

- **S3 bucket** `ethiolink-terraform-state` — holds every environment's `terraform.tfstate` at `env/<name>/terraform.tfstate`. Versioned, SSE-AES256 encrypted, block-public-access enabled, force-TLS bucket policy. `prevent_destroy = true`.
- **DynamoDB table** `ethiolink-terraform-locks` — `LockID` string hash key, pay-per-request billing. Shared across environments (Terraform's `LockID` already namespaces by `bucket/key`, so concurrent dev + prod applies don't block each other). `prevent_destroy = true`.
- **GitHub OIDC identity provider** — trust anchor at `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`. Lets workflows obtain short-lived AWS credentials without long-lived access keys in the repo.
- **`ethiolink-terraform-deploy` IAM role** — assumed by GitHub Actions via OIDC. Trust condition restricts the `sub` claim to `repo:hhenoktteklu/ethiolink:*` so only Actions runs inside this repository can assume it. Currently carries `AdministratorAccess` as a deliberate temporary choice while the Phase 7 modules land; tightened in a follow-up commit once a clean dev apply has been captured in CloudTrail to author the real least-privilege policy.

### One-time procedure

The bootstrap stack stores its own state on the operator's laptop — it can't store state in the bucket it's about to create. After the initial apply, the state file under `infra/terraform/bootstrap/.terraform/` may be left in place or optionally migrated into the bucket; the stack is small and rarely changes either way.

```bash
# 1. Authenticate to AWS as a principal with permission to create
#    the bootstrap resources (S3, DynamoDB, IAM). Typically the
#    account root or a one-shot operator IAM user with
#    AdministratorAccess.
aws sts get-caller-identity  # sanity check

# 2. Apply the bootstrap stack.
cd infra/terraform/bootstrap
terraform init
terraform plan
terraform apply

# 3. Note the `terraform_deploy_role_arn` output — its account-id
#    component is the value of `AWS_ACCOUNT_ID` referenced by the
#    GitHub Actions workflows. Add it as a repository secret in
#    GitHub:
#      Settings → Secrets and variables → Actions → New repository secret
#      Name: AWS_ACCOUNT_ID
#      Value: <12-digit account id>
terraform output terraform_deploy_role_arn

# 4. Verify the dev environment can `terraform init` against the
#    new remote backend (no apply yet — modules land in Phase 7
#    commits 2+).
cd ../environments/dev
terraform init
```

After step 4 succeeds, every subsequent Terraform action on dev or prod runs from CI via the `terraform-deploy` role. The PR plan workflow (`.github/workflows/terraform-plan.yml`) is the first such surface; the deploy workflows follow in later Phase 7 commits.

### Tightening the deploy-role policy

`AdministratorAccess` is the right tradeoff during bootstrap but the wrong shape for a steady-state CI role. The follow-up commit will:

1. Apply the dev environment from scratch once with `AdministratorAccess` to capture every real API call in CloudTrail.
2. Generate a least-privilege policy from those captured calls (`iamlive` or the AWS-managed `Access Analyzer` policy-generation surface).
3. Replace the `AdministratorAccess` attachment with the generated policy and re-apply the bootstrap.
4. Split the role: keep the broad role for the PR plan workflow (already read-only at the AWS surface because `terraform plan` is a no-op against API state) and add tighter, ref-scoped roles for the dev and prod apply workflows.

## Accounts and environments

- One AWS account.
- Two environments: `dev` and `prod`, separated by resource naming, Terraform workspaces, and IAM boundaries.
- A future `staging` environment is reserved but not built in MVP.

## Resources provisioned by Terraform

### Networking

Provisioned by `infra/terraform/modules/vpc/`. One VPC per environment with the topology below.

| Property              | Dev                                  | Prod                                  |
| --------------------- | ------------------------------------ | ------------------------------------- |
| VPC CIDR              | `10.0.0.0/16`                        | `10.1.0.0/16`                         |
| Availability zones    | 2 (first 2 from `aws_availability_zones`) | 2                                |
| Public subnets        | 2 × `/24` at `cidrsubnet(...,8,0..1)` | 2 × `/24` at `cidrsubnet(...,8,0..1)` |
| Private subnets       | 2 × `/24` at `cidrsubnet(...,8,10..11)` | 2 × `/24` at `cidrsubnet(...,8,10..11)` |
| Internet Gateway      | 1                                    | 1                                     |
| NAT Gateways          | 1 (single-AZ — accepts dev outages)  | 2 (one per AZ — survives single-AZ NAT outage) |
| Bastion SG            | not created                          | created (no associated instance until on-call need) |

CIDR carve-out leaves a 10-slot gap between public and private indexes so future tiers (dedicated DB subnet group at indexes 20+, ElastiCache at 30+, etc.) can land without renumbering the existing subnets.

Security groups:

- **`sg-lambda`** — egress allow-all, no ingress. Every EthioLink Lambda attaches to this SG; Lambdas don't accept inbound TCP (API Gateway and EventBridge invoke via the AWS plane, not VPC networking).
- **`sg-rds`** — ingress on TCP 5432 from `sg-lambda` (cross-SG reference, no hardcoded CIDR). When the bastion SG is present, an additional ingress rule from the bastion SG is added on the same port. No public exposure.
- **`sg-bastion`** *(prod only)* — ingress on TCP 22 from operator-supplied CIDRs (`bastion_allowed_cidrs`, empty by default — the operator adds their IP via an out-of-band rule when access is actually needed). Egress allow-all. The SG exists ahead of any actual bastion EC2 instance so launching one is a non-Terraform-blocking step.

VPC endpoints (S3, Secrets Manager) and flow logs are intentionally out of scope for the MVP VPC module — they land in follow-up commits once a real workload measures NAT egress cost.

### Cognito

- One user pool per environment.
- Three groups: `CUSTOMER`, `BUSINESS_OWNER`, `ADMIN`.
- App clients:
  - `ethiolink-mobile` (public, PKCE, no client secret) — Flutter app on the `ethiolink://auth/{callback,logout}` deep-link scheme.
  - `ethiolink-admin` (public, PKCE, no client secret) — React SPA. The dashboard runs the PKCE flow in-browser via `admin/src/lib/auth.ts`; the callback route is `/login?code=...` (the `LoginPage` component handles the exchange). The Cognito client's `callback_urls` and `logout_urls` MUST list the same `/login` path per environment:
    - Dev: `http://localhost:5173/login`
    - Prod: `https://admin.ethiolink.app/login`

  Group-level access control (only `ADMIN` group members can use the dashboard) is enforced at the application layer — both client-side (`isAdmin(session)` in `auth.ts` gates routing through `ProtectedRoute`) and server-side (`backend/lambdas/admin/_authz.ts` refuses non-`ADMIN` roles with 403 on every admin endpoint).

### API Gateway

- One REST API per environment.
- Cognito user-pool authorizer attached to all `/v1/*` routes except explicit public endpoints.
- Custom domain via ACM cert in `eu-west-1` for prod; default `*.execute-api` URL in dev.

### Lambda

- Node.js 20.x runtime.
- One Lambda per domain area (auth, businesses, services, staff, availability, appointments, reviews, media, admin, notifications).
- All Lambdas attach to the VPC and `sg-lambda` security group to reach RDS.
- Environment variables provided from Terraform; secrets from AWS Secrets Manager.

### RDS

- PostgreSQL 15.
- `db.t4g.small` in dev, `db.m6g.large` in prod (revisit on first load test).
- Multi-AZ in prod; single-AZ in dev.
- Automated backups: 7-day retention in dev, 35-day retention in prod.
- RDS Proxy in prod to manage Lambda connection pressure (added in Phase 7).

### S3

Provisioned by `infra/terraform/modules/s3/`. Three buckets per environment with the shared posture below.

| Bucket                                | Public read | Versioning | Lifecycle                                   | Server access logging |
| ------------------------------------- | ----------- | ---------- | ------------------------------------------- | --------------------- |
| `ethiolink-${env}-media-public`       | yes (via bucket policy, force-TLS) | off by default (`enable_public_bucket_versioning`) | none in MVP             | writes to `logs/media-public/` |
| `ethiolink-${env}-media-private`      | no (block-public-access all on) | on                                          | none in MVP             | writes to `logs/media-private/` |
| `ethiolink-${env}-logs`               | no (block-public-access all on) | off                                         | expire after `logs_expiration_days` (90 dev / 365 prod) | n/a                   |

Shared posture across all three buckets: SSE-AES256, `Object Ownership = BucketOwnerEnforced` (ACLs disabled), force-TLS bucket policy (`Deny s3:* when aws:SecureTransport=false`), `force_destroy = false` plus `prevent_destroy = true` on the lifecycle block (a `terraform destroy` cannot tear a bucket down if it has any content — the belt-and-braces against accidental loss of customer media).

CORS for the two media buckets is driven by the `admin_allowed_origins` and `mobile_allowed_origins` inputs. The public bucket allows `GET / HEAD` from the union of those origins; the private bucket additionally allows `PUT` so a browser-side presigned upload can preflight. Native mobile clients don't enforce CORS, so `mobile_allowed_origins` is empty by default.

`S3StorageGateway` (`backend/shared/adapters/storage/`) is the sole writer for both media buckets and picks the target by `IssueUploadUrlInput.isPublic`. Lambda env vars: `S3_BUCKET_MEDIA_PUBLIC` ← `media_public_bucket_name`, `S3_BUCKET_MEDIA_PRIVATE` ← `media_private_bucket_name`. A gateway-type VPC endpoint to S3 is intentionally not created in this module — it lands once the NAT egress cost on real traffic justifies the change.

### CloudWatch

- Log groups per Lambda, 30-day retention in dev, 90-day in prod.
- Dashboards: API errors, Lambda errors/duration, RDS CPU/connections/free-storage, S3 4xx/5xx.
- Alarms: API 5xx rate, Lambda error rate, RDS storage and CPU, RDS free memory.

### IAM

- One execution role per Lambda, scoped to only the resources that Lambda needs.
- A `deploy` role consumed by GitHub Actions OIDC for plan/apply.

## Configuration flow

Application config is provided to Lambdas via environment variables sourced from Terraform variables and Secrets Manager. The application reads its config from a single `loadConfig()` function in `backend/shared/config/` that validates required keys at startup. No hard-coded environment values anywhere in the code.

## Deployment pipeline (target state, built out in Phase 7)

GitHub Actions workflows:

- `lint-test.yml` on every PR — runs ESLint, unit tests for backend, Flutter analyze + test, React lint + test.
- `terraform-plan.yml` on PRs touching `infra/` — runs `terraform plan` against dev and posts the plan.
- `deploy-dev.yml` on merge to `main` — `terraform apply` to dev, deploy Lambdas, run smoke tests.
- `deploy-prod.yml` on manual dispatch with a release tag — same as dev, applied to prod with an approval gate.

## Disaster recovery (target state, Phase 8)

- Daily logical backups (`pg_dump`) to S3 in addition to RDS automated snapshots.
- Documented runbook to restore RDS from snapshot and re-point API Gateway to a recovered Lambda set.
- Quarterly DR drill that restores prod to a scratch environment.
