# Phase 1 — Auth

## Goal

Stand up authentication end-to-end: Cognito user pool provisioned via Terraform, a Lambda-backed `/v1/auth/sync` and `/v1/me` set of endpoints, and a clean `AuthProvider` abstraction so Cognito stays swappable. By the end of this phase a Flutter or curl client can register, log in, and read its own profile from the database.

## Scope

In scope:

- Terraform module: `infra/terraform/modules/cognito/` (user pool, groups, app clients).
- Terraform dev environment wiring for Cognito.
- Backend: `users` table migration; `AuthProvider` interface; Cognito implementation; `auth.sync` and `me` handlers.
- API Gateway authorizer wired to Cognito.
- Backend bootstrap: shared config loader, logger, repository base class, pg client setup.
- Local-development setup: `docker-compose.yml` for Postgres; instructions in `backend/README.md`.

Out of scope:

- Business or admin role functionality (Phases 2/5 cover that).
- Social login.
- MFA enforcement (Cognito allows opt-in MFA but we do not enforce it).
- React admin login (Phase 5).

## Files involved

- `infra/terraform/modules/cognito/{main.tf,variables.tf,outputs.tf}`
- `infra/terraform/environments/dev/main.tf` (consumes the Cognito module)
- `backend/db/migrations/0001_init.sql`
- `backend/db/migrations/0002_users.sql`
- `backend/shared/config/loadConfig.ts`
- `backend/shared/logging/logger.ts`
- `backend/shared/db/pgClient.ts`
- `backend/shared/repositories/baseRepository.ts`
- `backend/shared/adapters/auth/AuthProvider.ts`
- `backend/shared/adapters/auth/CognitoAuthProvider.ts`
- `backend/shared/domains/users/userService.ts`
- `backend/shared/domains/users/userRepository.ts`
- `backend/lambdas/auth/sync.ts`
- `backend/lambdas/me/get.ts`
- `backend/lambdas/me/patch.ts`
- `backend/tests/users/*`
- `backend/README.md`, `docker-compose.yml`

## Checklist

- [x] Cognito Terraform module provisioning user pool, three groups, two app clients.
- [ ] Dev environment Terraform applied; outputs captured (user pool id, app client ids).<!-- module wired in environments/dev/main.tf; `terraform apply` not yet run against AWS -->
- [x] `pgcrypto` and `citext` extensions enabled in migration 0001.
- [x] `users` table created in migration 0002.
- [x] `AuthProvider` interface defined and `CognitoAuthProvider` implemented.
- [ ] Cognito JWT validation works against the dev user pool (using `aws-jwt-verify` or equivalent).<!-- code wired with aws-jwt-verify; "works against the dev user pool" needs a live pool from `terraform apply` -->
- [ ] `POST /v1/auth/sync` upserts the calling user, defaulting role from Cognito groups.
- [ ] `GET /v1/me` returns the synced user.
- [ ] `PATCH /v1/me` updates display name and customer-profile-preferred-city.
- [ ] Local docker-compose Postgres + migrations runnable with `npm run db:migrate`.
- [ ] Unit tests for `userService` (sync, get, update) using an in-memory repository fake.

## Acceptance criteria

- A test user created in Cognito can hit `/v1/auth/sync` and a row appears in `users` with the correct role.
- A second call to `/v1/auth/sync` for the same user is a no-op (idempotent).
- `GET /v1/me` without a valid JWT returns 401.
- `GET /v1/me` with an `ADMIN`-group user returns `role: "ADMIN"`.
- Phase 1 does not change any non-auth-related files.

## Test plan

- Unit: `userService` happy path, idempotent sync, role mapping per Cognito group.
- Unit: `loadConfig()` errors loudly on missing required env vars.
- Integration (dev environment): create a Cognito test user, obtain an ID token via the Cognito hosted UI or `aws cognito-idp`, call `/v1/auth/sync` and `/v1/me`, assert 200 + correct body.
- Manual: confirm CloudWatch logs the request id and Cognito sub but not the JWT.

## Rollback notes

- The Cognito user pool can be retained on rollback (it is cheap and recreating it invalidates all client credentials). Terraform `prevent_destroy = true` is set on the user pool resource.
- Database changes are forward-only; if migration 0002 needs to be reverted, write a compensating migration that drops the table.
- Lambda code can be rolled back by re-deploying the previous artifact.
