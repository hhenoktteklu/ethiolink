# ADR-0001: AWS-first backend

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** EthioLink core team

## Context

EthioLink needs a backend that is durable, observable, and operable in Ethiopia with predictable cost. The team is starting from scratch and needs a stack that one or two engineers can run reliably while still scaling to a multi-vertical marketplace.

Alternative platforms considered:

- **Supabase** — fast to start, but the team explicitly wants to avoid lock-in to a managed Postgres-plus-edge-functions vendor whose pricing and feature set has shifted multiple times. Also, real-time row-level security tooling is more than we need for an appointment marketplace.
- **Firebase** — strong on mobile DX but pushes us toward Firestore (document model) and Cloud Functions, both of which are an uncomfortable fit for our relational booking domain. Also unwanted vendor lock-in.
- **Self-managed Kubernetes (EKS or otherwise)** — too much operational overhead for a small team at this stage.
- **AWS-first serverless (API Gateway + Lambda + RDS)** — mature, well-documented, and lets us pay close to nothing while the platform is small.

## Decision

We will build the backend on AWS using:

- **API Gateway (REST)** as the public HTTP front door.
- **Lambda** (Node.js 20) as the compute layer.
- **RDS PostgreSQL** as the system of record.
- **Cognito** for authentication.
- **S3** for media storage.
- **CloudWatch** for logs, metrics, and alarms.
- **Terraform** for infrastructure as code.

GraphQL/AppSync is explicitly out of scope for MVP — a REST API is sufficient for the breadth of our endpoints and keeps tooling simple.

DynamoDB is excluded unless a future use case is genuinely a poor fit for Postgres; we expect our domain to remain comfortably relational.

## Consequences

**Positive:**

- One vendor and one IaC tool keeps the operations surface area small.
- Postgres gives us strong consistency and proper relational modeling for bookings.
- Cognito covers signup, login, password reset, MFA, and JWT issuance without us writing auth ourselves.

**Negative:**

- AWS lock-in. Mitigated by clean-architecture boundaries: business logic never depends on AWS SDKs directly.
- Cold-start latency for Lambdas in VPC needs to be monitored; we will revisit provisioned concurrency or ARM-based images if p95 latency suffers.
- We accept the operational complexity of running Postgres on RDS (parameter groups, backups, maintenance windows) in exchange for relational fitness.
