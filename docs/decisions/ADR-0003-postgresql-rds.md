# ADR-0003: PostgreSQL on Amazon RDS as the system of record

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** EthioLink core team

## Context

EthioLink's domain is relational: businesses have services, services have prices, staff have availability, appointments tie staff to customers at specific times, and reviews are anchored to appointments. We need transactions, foreign keys, joins, and reasonable analytical queries.

Options considered:

- **DynamoDB** — strong on horizontal scale and pay-per-request pricing, but the data model fights us. Cross-entity queries (e.g., "all appointments for a business between two dates") become painful without secondary indexes that mirror SQL anyway.
- **Aurora Serverless v2** — attractive but more expensive at small scale and adds operational quirks. Worth revisiting at growth.
- **Self-managed Postgres on EC2** — too much operational burden for a small team.
- **RDS PostgreSQL** — managed Postgres with automated backups, snapshots, and Multi-AZ. A boring, reliable choice.

## Decision

Use **PostgreSQL 15 on Amazon RDS** as the system of record. Multi-AZ in production, single-AZ in dev. Schema changes flow through versioned SQL migrations under `backend/db/migrations/`.

Connection pressure from Lambda is managed initially by careful instance sizing and connection reuse within a single warm Lambda. **RDS Proxy** will be introduced in production in Phase 7 if connection counts become a constraint.

All access to the database goes through repository classes in the backend; service code never writes SQL inline. This is a discipline, not a framework — we use a thin query builder, not a full ORM, because the team prefers visibility into the SQL we run.

## Consequences

**Positive:**

- Strong consistency, transactions, foreign keys, and a query language we already know.
- Mature tooling (`pg_dump`, `pgbench`, `EXPLAIN ANALYZE`).
- Backups and snapshots are managed by AWS.

**Negative:**

- Vertical scale ceiling. Acceptable for a country-scale marketplace at MVP — we re-evaluate if any single table approaches hundreds of millions of rows.
- Postgres extensions are limited to what RDS supports; we use only `pgcrypto` and `citext` for MVP, both available.
- Lambda-to-RDS connection management requires care; RDS Proxy is on the roadmap.
