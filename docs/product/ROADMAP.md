# Roadmap

## Phase 0 — Setup (current)

Project scaffolding, documentation, ADRs, monorepo skeleton. No application code yet.

## Phase 1 — Auth

Cognito user pool, role-based authorization, profile sync to RDS for CUSTOMER, BUSINESS_OWNER, and ADMIN. Auth abstraction layer in backend so Cognito stays swappable.

## Phase 2 — Business profiles

Business onboarding flow: create profile, upload photos, submit for approval. Admin approval workflow (read path in this phase, write path in Phase 5).

## Phase 3 — Services and staff

CRUD for services (name, duration, price) and staff. Weekly recurring availability with overrides.

## Phase 4 — Booking

End-to-end booking: search businesses, pick a service and staff member, choose a time slot, confirm. Business accept/reject flow. Customer cancel/reschedule.

## Phase 5 — Admin dashboard

React + TypeScript admin UI. Approve businesses, manage users and businesses, manage categories, view bookings, feature listings.

## Phase 6 — Notifications

Notification abstraction with SMS, email, and Telegram channels. Mock provider in dev; pluggable real providers for Ethiopian SMS gateways. Notification log persisted in RDS.

## Phase 7 — AWS deployment

Terraform end-to-end for dev and prod environments. GitHub Actions CI/CD: lint, test, build, deploy. CloudWatch dashboards and alarms.

## Phase 8 — Production hardening

Rate limiting, WAF, secret rotation, RDS backups verified, disaster recovery runbook, load testing, observability gaps closed, security review.

## Post-MVP — Marketplace expansion (not in MVP scope)

- Online payments: Telebirr, Chapa, CBE Birr.
- Amharic UI.
- Push notifications.
- Event ticketing vertical.
- Product marketplace vertical.
- Car dealership listings vertical.
- In-app chat.
- Loyalty / promotions engine.
