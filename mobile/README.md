# EthioLink Mobile (Flutter)

A single Flutter codebase serving both customer and business owner roles. Role gating is driven by the authenticated user's Cognito group.

## Current state (Phase 0)

This directory is intentionally a placeholder. `flutter create` is run at the start of Phase 1 by the Flutter agent. The intended structure once initialized:

```
mobile/
  lib/
    main.dart
    app.dart
    core/             config, theme, http, auth, localization
    features/
      auth/           {data,domain,presentation}
      browse/
      business_profile/
      booking/
      profile/
      business_owner/ business-side flows
    shared/           reusable widgets and types
  test/
  l10n/               translations (en.arb at MVP; am.arb later)
  android/
  ios/
```

See `pubspec.placeholder.yaml` for the planned dependency set.
