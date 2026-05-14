# EthioLink

A production-ready marketplace platform for Ethiopia, starting with **beauty appointment booking** (salons, barbers, spas, beauty professionals).

The architecture is built to expand into additional marketplace verticals in the future (event ticketing, product marketplace, car dealerships), but the MVP is **strictly scoped to beauty appointment booking**.

## Repository layout

```
mobile/        Flutter mobile app (customers + businesses)
admin/         React + TypeScript admin dashboard
backend/       AWS Lambda functions, shared services, DB migrations
infra/         Terraform IaC for all AWS resources
docs/          Product, architecture, ADRs, phase task files
.github/       CI/CD workflows (added in later phases)
```

## Tech stack

| Layer            | Choice                                  |
| ---------------- | --------------------------------------- |
| Mobile           | Flutter                                 |
| Admin dashboard  | React + TypeScript                      |
| API              | AWS Lambda + API Gateway (REST)         |
| Database         | Amazon RDS PostgreSQL                   |
| Auth             | Amazon Cognito                          |
| Storage          | Amazon S3                               |
| IaC              | Terraform                               |
| CI/CD            | GitHub Actions (added in Phase 7)       |
| Monitoring       | CloudWatch                              |

Explicitly **not** used: Supabase, Firebase, DynamoDB (unless absolutely necessary), AppSync (for MVP).

## Where to start

1. Read `docs/product/PRD.md` for product vision and `docs/product/MVP_SCOPE.md` for the strict MVP cut.
2. Read `docs/architecture/SYSTEM_ARCHITECTURE.md` for the high-level design.
3. Work through `docs/tasks/PHASE_0_SETUP.md` and the subsequent phase files in order.
4. Each architectural decision lives in `docs/decisions/` as a numbered ADR.

## Current status

Phase 0 (project scaffolding + documentation) is complete. No application code has been written yet — that begins in Phase 1.
