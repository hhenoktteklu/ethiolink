# ADR-0002: Cognito as the identity provider

- **Status:** Accepted
- **Date:** 2026-05-13
- **Deciders:** EthioLink core team

## Context

EthioLink needs authentication for three roles (CUSTOMER, BUSINESS_OWNER, ADMIN) across two clients (Flutter mobile app, React admin dashboard). Ethiopia-specific constraints: phone-number signups are common, and most users will not have a credit card or social-network account.

Options considered:

- **Roll our own auth** on top of Postgres + JWT — high security risk for a small team.
- **Auth0** — a strong managed option but priced in USD and not significantly better for our use case than Cognito.
- **Firebase Auth** — rejected with the rest of Firebase (see ADR-0001).
- **Amazon Cognito** — native AWS integration, supports email and phone signups, supports user groups for role separation, JWTs are usable by API Gateway authorizers out of the box.

## Decision

Use **Amazon Cognito user pools** as the identity provider. Three groups map to the three application roles: `CUSTOMER`, `BUSINESS_OWNER`, `ADMIN`. App clients use PKCE.

On first authenticated request, the backend syncs the Cognito `sub` into the `users` table to establish an internal identifier. From that point onward all foreign keys reference `users.id`, not the Cognito `sub`. This keeps the option open to swap identity providers in the future without rewriting the data model.

The backend exposes its dependency on Cognito only through a single `AuthProvider` interface in `backend/shared/adapters/auth/`. Service-layer code authenticates by calling that interface; the Cognito-specific implementation lives behind it.

Social login (Google, Apple, Facebook) is explicitly deferred to post-MVP.

## Consequences

**Positive:**

- Auth flows (signup, login, password reset, MFA, refresh) come for free.
- API Gateway can validate the JWT without code in our Lambdas.
- Group-based authorization keeps role logic out of the database.

**Negative:**

- Cognito error messages and console UX are imperfect; we will absorb the rough edges in our own Flutter and React flows.
- Phone-number signup in Ethiopia requires an SMS provider that Cognito can call. In MVP we accept Cognito's default SMS path; we revisit if cost or deliverability becomes an issue.
- The `AuthProvider` abstraction means slightly more code than a direct dependency, but it pays for itself the first time we swap or augment providers.
