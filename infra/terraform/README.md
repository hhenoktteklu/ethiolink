# EthioLink Infrastructure (Terraform)

Region: `eu-west-1`. Two environments: `dev` and `prod`. Modules are referenced from `environments/<env>/main.tf`.

## Layout

```
infra/terraform/
  environments/
    dev/    main.tf, variables.tf, outputs.tf, backend.tf
    prod/   main.tf, variables.tf, outputs.tf, backend.tf
  modules/
    cognito/        user pool, groups, app clients
    api-gateway/    REST API + Cognito authorizer
    lambda/         reusable Lambda function module
    rds/            PostgreSQL + parameter groups + subnet groups
    s3/             buckets (public, private, logs)
    cloudwatch/     dashboards, alarms, log groups
```

## Current state (Phase 0)

Empty environment stubs only. No real Terraform resources are declared yet. Module bodies and resource declarations land starting in Phase 1 (Cognito) and continue through Phase 7 (full provisioning).

## Conventions

- Resource names: `ethiolink-<env>-<short-name>`.
- Tags applied to every resource: `Project=ethiolink`, `Environment=<env>`, `ManagedBy=terraform`.
- `prevent_destroy = true` is set in prod on Cognito user pool, RDS instance, and S3 buckets.
- No secrets in `*.tfvars`. Secrets are created in Secrets Manager out-of-band and referenced by ARN.
- Backend state lives in S3 with DynamoDB locking — bucket and table created manually once per AWS account before the first `terraform init`.
