# EthioLink Backend

AWS Lambda + API Gateway + RDS PostgreSQL. Node.js 20, TypeScript.

## Layout

```
backend/
  lambdas/    Lambda handlers (entrypoints — thin)
  api/        OpenAPI document
  db/
    migrations/   Forward-only SQL migrations
    seeds/        Seed data (categories, etc.)
  shared/
    config/         loadConfig()
    logging/        structured logger
    db/             pg client + base repository
    adapters/       AWS adapters (auth, storage, payments, notifications)
    domains/        domain services and repositories
  tests/      unit + integration tests
```

## Current state (Phase 0)

Scaffolding only — no executable code yet. `npm run build`, `npm test`, and `npm run db:migrate` are stubs that succeed but do nothing. They are wired up properly in Phase 1.

## Running locally (Phase 1+)

```
cp .env.example .env
docker-compose up -d   # Postgres
npm install
npm run db:migrate
npm run build
npm test
```
