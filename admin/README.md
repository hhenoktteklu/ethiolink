# EthioLink Admin Dashboard

React + TypeScript SPA for operators. Restricted to the Cognito `ADMIN` group.

## Current state (Phase 0)

Placeholder only. The Vite + React project is initialized at the start of Phase 5 by the admin-dashboard agent. Until then this directory holds a stub `package.json` so the workspace declaration in the root `package.json` is satisfied.

## Intended structure (Phase 5)

```
admin/
  index.html
  vite.config.ts
  tsconfig.json
  src/
    main.tsx
    App.tsx
    lib/
      api.ts
      auth.ts
    pages/
      Login.tsx
      Dashboard.tsx
      Businesses.tsx
      BusinessDetail.tsx
      Users.tsx
      Categories.tsx
      Bookings.tsx
    components/
    i18n/
      en.ts
```
