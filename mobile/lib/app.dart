// EthioLink Mobile — root widget + theme + navigation skeleton.
//
// The scaffold ships a Material 3 root `MaterialApp` with a
// single-route tree: the placeholder login screen is the initial
// route and pushes the placeholder home (browse) on "sign in".
// `go_router` adoption is a follow-up commit when the route tree
// grows past 3-4 screens.
//
// `EthioLinkApp` takes the resolved `AppConfig` via constructor so
// tests can construct it directly (no global initialisation).
// Downstream widgets read the config off the
// `AppConfigScope.of(context)` inherited widget — keeps the
// dependency explicit and avoids a Riverpod / GetIt commit prior
// to the state-management track.
//
// Phase 9 Track 5 — `AppLocalizations` (generated from
// `lib/l10n/app_en.arb` by Flutter's `gen-l10n`) is wired into
// `MaterialApp` via `localizationsDelegates` + `supportedLocales`.
// `LocaleScope` publishes the active `Locale` to the rebuilder so
// the future locale-picker commit can swap languages by mutating
// the controller without touching `MaterialApp` directly.

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';

import 'core/config/app_config.dart';
import 'core/config/app_config_scope.dart';
import 'core/i18n/locale_preferences.dart';
import 'core/i18n/locale_scope.dart';
import 'features/auth/login_screen.dart';

class EthioLinkApp extends StatefulWidget {
  const EthioLinkApp({
    required this.config,
    this.localePreferencesOverride,
    super.key,
  });

  final AppConfig config;

  /// Test seam — production leaves this `null` and the state
  /// constructs a `SecureLocalePreferences`. Widget tests inject
  /// an `InMemoryLocalePreferences` to stay platform-channel-free.
  final LocalePreferences? localePreferencesOverride;

  @override
  State<EthioLinkApp> createState() => _EthioLinkAppState();
}

class _EthioLinkAppState extends State<EthioLinkApp> {
  // Controller is owned by the root state so it survives across
  // hot reloads + locale-picker mutations. Defaults to English;
  // the secure-storage cache (when present) overrides it on boot
  // so a returning user sees their chosen language without
  // waiting for the network round-trip.
  final LocaleController _locale = LocaleController();
  late final LocalePreferences _preferences;

  @override
  void initState() {
    super.initState();
    _preferences = widget.localePreferencesOverride ??
        const SecureLocalePreferences();
    // Fire-and-forget cache read. If the cache has a value we
    // adopt it; otherwise the UI stays English until the user
    // picks something. The read is async and may complete after
    // the first frame; the `LocaleController` notifies listeners
    // so the `MaterialApp` rebuilds when it lands.
    _preferences.read().then((cached) {
      if (cached != null && mounted) {
        _locale.locale = cached;
      }
    });
  }

  @override
  void dispose() {
    _locale.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AppConfigScope(
      config: widget.config,
      child: LocaleScope(
        notifier: _locale,
        child: AnimatedBuilder(
          // Rebuild MaterialApp whenever the locale controller
          // fires. Today this only happens on construction; the
          // picker commit drives it from a Settings screen.
          animation: _locale,
          builder: (context, _) {
            return MaterialApp(
              title: 'EthioLink',
              debugShowCheckedModeBanner: false,
              theme: _buildTheme(),
              locale: _locale.locale,
              localizationsDelegates: AppLocalizations.localizationsDelegates,
              supportedLocales: AppLocalizations.supportedLocales,
              home: const LoginScreen(),
            );
          },
        ),
      ),
    );
  }

  ThemeData _buildTheme() {
    // EthioLink palette — preliminary. The design pass refines
    // the seed colour and adds a dark variant in a follow-up
    // commit; for the scaffold we just want a coherent Material 3
    // theme tinted enough to look like a real app shell.
    final colorScheme = ColorScheme.fromSeed(
      seedColor: const Color(0xFF7B3F00), // warm chestnut tone.
      brightness: Brightness.light,
    );

    return ThemeData(
      colorScheme: colorScheme,
      useMaterial3: true,
      visualDensity: VisualDensity.adaptivePlatformDensity,
      appBarTheme: AppBarTheme(
        backgroundColor: colorScheme.surface,
        foregroundColor: colorScheme.onSurface,
        centerTitle: false,
        elevation: 0,
      ),
    );
  }
}
