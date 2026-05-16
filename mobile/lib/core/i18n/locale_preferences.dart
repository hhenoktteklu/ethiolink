// EthioLink Mobile — locale preference persistence.
//
// Phase 9 Track 5 locale-picker commit. A thin wrapper around
// `flutter_secure_storage` so the user's chosen locale survives
// app restarts. The server-side `users.locale` row remains the
// canonical source of truth — this cache is just a UX
// optimization: the next cold-start renders the UI in the right
// language immediately, without waiting for the
// `GET /v1/me` round-trip.
//
// Why `flutter_secure_storage` instead of `shared_preferences`?
//   * The scaffold already depends on it for the Cognito token
//     cache; not pulling in a second persistence library keeps the
//     dependency set lean.
//   * The data is non-sensitive (a 2-letter locale code) but the
//     library handles the platform-channel + Keychain / Keystore
//     wiring already — no reason to duplicate it.
//
// Test seam: callers can pass a custom `FlutterSecureStorage`
// instance (the scaffolds widget tests use it to stay
// platform-channel-free).

import 'package:flutter/widgets.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Async, secure-storage backed cache for the user's chosen
/// locale. Production callers use the no-arg constructor; tests
/// inject a fake.
abstract class LocalePreferences {
  /// Read the cached locale. Returns `null` when no value has
  /// been written yet (first-run users); the caller falls back to
  /// the platform locale or the bundled default.
  Future<Locale?> read();

  /// Persist the locale. Best-effort: the picker calls this only
  /// after the server-side PATCH succeeds, so any storage error
  /// becomes a logged warning rather than user-visible noise.
  Future<void> write(Locale locale);
}

class SecureLocalePreferences implements LocalePreferences {
  const SecureLocalePreferences({
    this.storage = const FlutterSecureStorage(),
  });

  final FlutterSecureStorage storage;

  /// Storage key. Prefixed with `ethiolink.` to avoid colliding
  /// with the Cognito token entries. The value is a raw locale
  /// language code (`'en'` / `'am'`); MVP doesn't carry region
  /// or script.
  static const String storageKey = 'ethiolink.user.locale';

  @override
  Future<Locale?> read() async {
    final value = await storage.read(key: storageKey);
    if (value == null || value.isEmpty) return null;
    return Locale(value);
  }

  @override
  Future<void> write(Locale locale) async {
    await storage.write(key: storageKey, value: locale.languageCode);
  }
}

/// In-memory `LocalePreferences` for tests and offline demos.
/// Mirrors the secure-storage shape without touching the platform
/// channel; the `seed` constructor pre-populates a value so a
/// widget test can simulate "user previously chose Amharic".
class InMemoryLocalePreferences implements LocalePreferences {
  InMemoryLocalePreferences({Locale? seed}) : _value = seed;
  Locale? _value;

  @override
  Future<Locale?> read() async => _value;

  @override
  Future<void> write(Locale locale) async => _value = locale;
}
