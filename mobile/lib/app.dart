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

import 'package:flutter/material.dart';

import 'core/config/app_config.dart';
import 'core/config/app_config_scope.dart';
import 'features/auth/login_screen.dart';

class EthioLinkApp extends StatelessWidget {
  const EthioLinkApp({required this.config, super.key});

  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    return AppConfigScope(
      config: config,
      child: MaterialApp(
        title: 'EthioLink',
        debugShowCheckedModeBanner: false,
        theme: _buildTheme(),
        home: const LoginScreen(),
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
