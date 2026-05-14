# System Architecture

## 1. High-level diagram

```
+----------------+        +----------------+        +------------------+
| Flutter mobile |        | React admin    |        | Telegram / SMS   |
| (customer +    |        | dashboard      |        | (notification    |
|  business)     |        | (admin)        |        |  channels)       |
+--------+-------+        +--------+-------+        +---------+--------+
         |                         |                          ^
         | HTTPS/JSON              | HTTPS/JSON               | outbound
         v                         v                          |
+------------------------------------------------------+      |
|                AWS API Gateway (REST)                |      |
+----------------------+-------------------------------+      |
                       |                                      |
                       v                                      |
+------------------------------------------------------+      |
|              AWS Lambda functions                    |      |
|  (controllers -> services -> repositories)           |      |
+---+-------------+----------------+-------------------+      |
    |             |                |                          |
    v             v                v                          |
+--------+   +----------+    +-----------+                    |
| RDS    |   | S3       |    | Cognito   |                    |
| Postgres|  | (media)  |    | (auth)    |                    |
+--------+   +----------+    +-----------+                    |
                                                              |
                                +--------------+              |
                                | Notification |              |
                                | adapter      +--------------+
                                +--------------+
```

## 2. Components

### Mobile app (Flutter)

A single Flutter codebase serves both the customer and business experiences. Roles are gated at runtime based on the authenticated user's Cognito group. Mobile-first, low-bandwidth-friendly, English-only at MVP with all strings externalized for future Amharic.

### Admin dashboard (React + TypeScript)

Desktop-first. Same REST API as mobile. Restricted to users in the `ADMIN` Cognito group.

### API Gateway

REST API in front of Lambda. Cognito authorizer enforces authentication and surfaces the user's role claim to downstream Lambdas. CORS configured for the admin dashboard origin.

### Lambda functions

Backend business logic. Organized by domain (auth, businesses, services, staff, availability, appointments, admin, media, notifications). Internally each Lambda follows a clean-architecture split:

- **Controller** layer: parses HTTP input, validates, calls services.
- **Service** layer: pure business logic, no AWS SDK calls.
- **Repository** layer: data access against RDS PostgreSQL.
- **Adapter** layer: wraps AWS-specific concerns (Cognito calls, S3 signed URLs, notification providers).

The service layer never imports the AWS SDK directly. Adapters live behind interfaces so we can swap providers (e.g., notification channel from mock to real SMS gateway) without touching business logic.

### RDS PostgreSQL

Single primary instance for MVP (Multi-AZ for prod). Schema managed with versioned SQL migrations under `backend/db/migrations`. Connection pooling via RDS Proxy when warranted.

### Cognito

User pool with three groups: `CUSTOMER`, `BUSINESS_OWNER`, `ADMIN`. Email or phone for sign-up. Cognito user identifiers are mirrored into the `users` table on first login (idempotent profile sync).

### S3

Buckets for media assets (business photos, profile images). Direct uploads use API-issued pre-signed PUT URLs. Reads use either public URLs (for listed media) or pre-signed GETs.

### Notification adapter

A single internal interface, `NotificationGateway`, with implementations for: mock (default in dev/MVP), SMS provider (planned for Phase 6), Telegram bot (planned for Phase 6). The application code only ever talks to the interface.

### Payment adapter

A single internal interface, `PaymentGateway`, with a `CashGateway` (no-op confirmation) and a `MockOnlineGateway` for MVP. Real Ethiopian providers (Telebirr, Chapa, CBE Birr) plug in post-MVP without changing business logic.

## 3. Clean-architecture conventions

- **Domain logic lives in `backend/shared/`**, not in individual Lambda handlers, so logic is reusable and testable in isolation.
- **No AWS SDK calls in the service layer.** Adapters in `backend/shared/adapters/` wrap AWS-specific work.
- **No business logic in adapters.** Adapters are thin translations between domain types and external systems.
- **Lambda handlers are entrypoints, not implementations.** A handler should parse input, call a service, and serialize the response. Anything more belongs in `shared/`.
- **Migrations are the source of truth for schema.** No ad-hoc `psql` changes.

## 4. Environments

- **dev**: shared development environment in AWS.
- **prod**: production environment.
- A future **staging** environment is reserved but not built in MVP.

Each environment has its own Terraform state, its own Cognito user pool, its own RDS instance, and its own S3 buckets. Configuration values flow into Lambda via environment variables sourced from Terraform.

## 5. Future extensibility

The system is structured so additional verticals (event ticketing, product marketplace, car dealerships) can be added as new domain modules under `backend/shared/domains/` and new Lambdas under `backend/lambdas/`. Cross-cutting infrastructure (auth, storage, notifications, payments) is shared. The MVP intentionally does **not** scaffold these future modules.
