// EthioLink Mobile — `InheritedWidget` for `AppConfig` access.
//
// Wraps the entire app at boot (see `EthioLinkApp.build`). Every
// descendant widget reads the resolved config via
// `AppConfigScope.of(context)`. The pattern is the Flutter
// idiomatic equivalent of a context-injected service — no
// Riverpod / GetIt dependency required at scaffold time.
//
// `updateShouldNotify` returns `false` because the config is
// immutable for the lifetime of the app. If a future commit
// supports hot-swapping environment (unlikely — operators
// re-launch the build target instead), this flag flips.

import 'package:flutter/widgets.dart';

import 'app_config.dart';

class AppConfigScope extends InheritedWidget {
  const AppConfigScope({
    required this.config,
    required super.child,
    super.key,
  });

  final AppConfig config;

  static AppConfig of(BuildContext context) {
    final scope = context
        .dependOnInheritedWidgetOfExactType<AppConfigScope>();
    assert(
      scope != null,
      'AppConfigScope.of called outside an AppConfigScope. '
      'Wrap the app in AppConfigScope at boot.',
    );
    return scope!.config;
  }

  @override
  bool updateShouldNotify(AppConfigScope oldWidget) => false;
}
