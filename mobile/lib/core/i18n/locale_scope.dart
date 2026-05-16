// EthioLink Mobile — app-level locale state.
//
// Phase 9 Track 5 i18n scaffold. A lightweight `InheritedWidget`
// that publishes the currently selected `Locale` to the
// `MaterialApp` (via the `locale` parameter) and to any widget
// that wants to read or react to a locale change.
//
// Today the active locale is always `en` — `supportedLocales` is
// `[en]` in `AppLocalizations` and there is no UI picker. The
// scope exists so the future locale-picker commit has a place to
// plug in:
//
//   * Picker widget calls `LocaleScope.maybeOf(context)?.setLocale(...)`
//   * The notifier fires; `MaterialApp` rebuilds with the new locale.
//   * `users.locale` PATCH happens through the existing
//     `UserRepository` Dart port; the scope is purely a UI state
//     surface, not the source of truth.
//
// Why not `Provider` or `Riverpod`? The scaffold doesn't ship a
// state-management library yet (see `mobile/README.md`). A
// hand-rolled `InheritedNotifier` keeps this commit additive —
// nothing else in the tree needs to change.

import 'package:flutter/widgets.dart';

/// Mutable notifier holding the active `Locale`. The picker
/// commit subscribes to this via `LocaleScope.maybeOf(context)`
/// and calls `setLocale`. For now there's no caller — the
/// notifier is constructed with `Locale('en')` and never mutates.
class LocaleController extends ChangeNotifier {
  LocaleController({Locale initial = const Locale('en')}) : _locale = initial;

  Locale _locale;

  Locale get locale => _locale;

  /// Sets the active locale. Re-fires listeners only when the
  /// value actually changed (avoid spurious rebuilds).
  set locale(Locale value) {
    if (_locale == value) return;
    _locale = value;
    notifyListeners();
  }
}

/// InheritedNotifier wiring the `LocaleController` into the
/// widget tree. Children read via `LocaleScope.maybeOf(context)`
/// (returns `null` outside the scope — useful for widget tests
/// that pump a screen directly without the full app shell).
class LocaleScope extends InheritedNotifier<LocaleController> {
  const LocaleScope({
    required LocaleController super.notifier,
    required super.child,
    super.key,
  });

  /// Returns the active controller, or `null` when no
  /// `LocaleScope` ancestor is present. Useful for tests.
  static LocaleController? maybeOf(BuildContext context) {
    return context
        .dependOnInheritedWidgetOfExactType<LocaleScope>()
        ?.notifier;
  }

  /// Returns the active controller. Throws when no `LocaleScope`
  /// ancestor is present — production code paths inside
  /// `MaterialApp` always have one.
  static LocaleController of(BuildContext context) {
    final controller = maybeOf(context);
    assert(
      controller != null,
      'LocaleScope.of called outside any LocaleScope ancestor. '
      'Wrap your subtree in a LocaleScope (see EthioLinkApp).',
    );
    return controller!;
  }
}
