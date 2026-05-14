# AWS Deployment

## Region

Primary region: `eu-west-1` (Ireland). This is the closest AWS region to Ethiopia with the full set of services we need and acceptable latency. Re-evaluate when AWS Cape Town (`af-south-1`) gains parity for Cognito and RDS Proxy.

## Accounts and environments

- One AWS account.
- Two environments: `dev` and `prod`, separated by resource naming, Terraform workspaces, and IAM boundaries.
- A future `staging` environment is reserved but not built in MVP.

## Resources provisioned by Terraform

### Networking

- One VPC per environment with public + private subnets across two AZs.
- NAT Gateway in each environment (single AZ in dev, two AZs in prod).
- Security groups: `sg-rds`, `sg-lambda`, `sg-bastion` (prod only).

### Cognito

- One user pool per environment.
- Three groups: `CUSTOMER`, `BUSINESS_OWNER`, `ADMIN`.
- App clients:
  - `ethiolink-mobile` (public, PKCE).
  - `ethiolink-admin` (public, PKCE, restricted to ADMIN group at the application layer).

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

- Three buckets per environment:
  - `ethiolink-${env}-media-public` — publicly readable assets (business cover photos).
  - `ethiolink-${env}-media-private` — private assets, served via pre-signed GET URLs.
  - `ethiolink-${env}-logs` — access logs.
- Block-public-access on the private and logs buckets.

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
