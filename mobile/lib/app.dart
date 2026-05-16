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
import 'package:flutter_gen/gen_l10n/app_localizations.dart';

import 'core/config/app_config.dart';
import 'core/config/app_config_scope.dart';
import 'core/i18n/locale_scope.dart';
import 'features/auth/login_screen.dart';

class EthioLinkApp extends StatefulWidget {
  const EthioLinkApp({required this.config, super.key});

  final AppConfig config;

  @override
  State<EthioLinkApp> createState() => _EthioLinkAppState();
}

class _EthioLinkAppState extends State<EthioLinkApp> {
  // Controller is owned by the root state so it survives across
  // hot reloads + locale-picker mutations. Today the picker
  // doesn't exist so the locale stays `en` for the app's whole
  // lifetime.
  final LocaleController _locale = LocaleController();

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
