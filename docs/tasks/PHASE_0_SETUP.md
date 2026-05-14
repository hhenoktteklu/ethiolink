# Phase 0 — Setup

## Goal

Establish the EthioLink project foundation: complete documentation, ADRs, the monorepo directory layout, and the minimum config files needed before any application code is written. This phase is intentionally code-light; the deliverable is a repo someone can clone and immediately understand.

## Scope

- All product, architecture, and decision documents.
- Phase task files for Phases 0–8.
- Agent prompt files for downstream specialized work.
- Monorepo directory skeleton (`mobile/`, `admin/`, `backend/`, `infra/`, `.github/`).
- Top-level config: `README.md`, `.gitignore`, `.editorconfig`, `.nvmrc`, root `package.json` (workspace placeholder).
- Backend package skeleton: `backend/package.json`, `backend/tsconfig.json`, `backend/api/openapi.yaml` stub.
- Mobile placeholder: `mobile/README.md`, `mobile/pubspec.placeholder.yaml`.
- Admin placeholder: `admin/README.md`, `admin/package.json` stub.
- Infra placeholders: top-level `infra/terraform/README.md`, `infra/terraform/environments/dev/main.tf` stub, `infra/terraform/environments/prod/main.tf` stub.
- Environment example: `backend/.env.example`.

Explicitly **out of scope** for Phase 0: any working code, real Terraform resources, Flutter project initialization, React project initialization, GitHub Actions workflows.

## Files involved

- `README.md`
- `.gitignore`
- `.editorconfig`
- `.nvmrc`
- `package.json` (root, workspaces declaration only)
- `docs/product/PRD.md`
- `docs/product/MVP_SCOPE.md`
- `docs/product/ROADMAP.md`
- `docs/architecture/SYSTEM_ARCHITECTURE.md`
- `docs/architecture/DATABASE_SCHEMA.md`
- `docs/architecture/API_SPEC.md`
- `docs/architecture/AWS_DEPLOYMENT.md`
- `docs/decisions/ADR-0001-aws-first-backend.md`
- `docs/decisions/ADR-0002-cognito-auth.md`
- `docs/decisions/ADR-0003-postgresql-rds.md`
- `docs/decisions/ADR-0004-s3-storage.md`
- `docs/tasks/PHASE_0_SETUP.md` … `PHASE_8_PRODUCTION_HARDENING.md`
- `docs/prompts/agent-*.md` (7 files)
- `backend/package.json`, `backend/tsconfig.json`, `backend/.env.example`, `backend/api/openapi.yaml`
- `mobile/README.md`, `mobile/pubspec.placeholder.yaml`
- `admin/README.md`, `admin/package.json`
- `infra/terraform/README.md`, `infra/terraform/environments/{dev,prod}/main.tf`

## Checklist

- [x] Create documentation directory tree under `docs/`.
- [x] Write `docs/product/PRD.md`.
- [x] Write `docs/product/MVP_SCOPE.md`.
- [x] Write `docs/product/ROADMAP.md`.
- [x] Write `docs/architecture/SYSTEM_ARCHITECTURE.md`.
- [x] Write `docs/architecture/DATABASE_SCHEMA.md`.
- [x] Write `docs/architecture/API_SPEC.md`.
- [x] Write `docs/architecture/AWS_DEPLOYMENT.md`.
- [x] Write four ADRs.
- [x] Write phase task files for Phases 0–8.
- [x] Write seven agent prompt files in `docs/prompts/`.
- [x] Create monorepo directory skeleton.
- [x] Write top-level `README.md`, `.gitignore`, `.editorconfig`, `.nvmrc`, root `package.json`.
- [x] Write `backend/package.json`, `backend/tsconfig.json`, `backend/.env.example`, `backend/api/openapi.yaml` stub.
- [x] Write `mobile/README.md` and `mobile/pubspec.placeholder.yaml`.
- [x] Write `admin/README.md` and `admin/package.json` stub.
- [x] Write `infra/terraform/README.md` and `environments/{dev,prod}/main.tf` stubs.

## Acceptance criteria

- A new contributor can clone the repo and, from `README.md` alone, find their way to product docs, architecture docs, and the active phase.
- All seven phase task files exist and each lists goal, scope, files, checklist, acceptance criteria, test plan, and rollback notes.
- No application code has been added.
- The directory structure matches the layout described in `README.md` and `SYSTEM_ARCHITECTURE.md`.

## Test plan

- Manual inspection: `find docs -type f` lists every doc described above.
- Manual inspection: directory tree matches the layout in the README.
- `grep -R "TODO" docs/` returns no surprising or critical TODOs (it is acceptable for phase files to contain forward-looking TODOs).

## Rollback notes

Phase 0 only adds new files. To roll back, delete the new files and directories. No external systems are touched and no migrations have been applied.
