// EthioLink Mobile — entry point.
//
// Phase 9 Track 3 scaffold. The runtime flow:
//
//   1. `WidgetsFlutterBinding.ensureInitialized()` — required
//      before any platform-channel call (we don't make one yet,
//      but the call is harmless and future-proofs the bootstrap
//      for the auth-storage commit that DOES need it).
//   2. Load `AppConfig` from `--dart-define-from-file=env/dev.json`
//      (or per-platform equivalents). The config carries the API
//      base URL, Cognito hosted-UI domain, Cognito mobile-client
//      id, and the deep-link callback / logout URIs. See
//      `lib/core/config/app_config.dart` + `env/dev.example.json`
//      for the contract.
//   3. Run the root `EthioLinkApp` widget with the loaded config
//      injected via constructor (no global singletons; tests pass
//      an in-memory config).
//
// Bootstrap intentionally throws on missing required config —
// failing loud at startup is preferred over a silent half-working
// app that surprises a user later. Tests construct `AppConfig`
// directly and bypass the dart-define lookup entirely.

import 'package:flutter/widgets.dart';

import 'app.dart';
import 'core/config/app_config.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  // Reads compile-time `--dart-define` / `--dart-define-from-file`
  // values. Throws `MissingConfigError` when a required key is
  // empty — surfaces a clear error in the Flutter Inspector
  // rather than booting the app with a half-wired config.
  final config = AppConfig.fromCompileTimeEnv();

  runApp(EthioLinkApp(config: config));
}
