// EthioLink Mobile — per-role theme builder.
//
// `BrowseScreen` wraps its body in `Theme(data: roleThemeFor(...))`
// so every descendant — AppBars, FilledButtons, NavigationBar
// indicators, Cards — picks up the role's palette without a
// pile of `Theme.of(context).colorScheme.primary` overrides
// scattered around the codebase.
//
// We derive the ColorScheme from the role's `primarySeed` via
// `ColorScheme.fromSeed`; Material 3 then computes the matched
// container / on-* / surfaceTint colours so the role's palette
// applies consistently to every Material component.
//
// The base theme below mirrors the customer-grade theme already
// in `app.dart` (Material 3, AppBar with surface background +
// no elevation, adaptive visual density). The only per-role
// surface that differs structurally is the AppBar's foreground
// — for the slate-tinted admin role we flip it to onPrimary
// over a primary background so the operator-console identity
// reads at a glance.

import 'package:flutter/material.dart';

import 'role_experience.dart';

/// Build a [ThemeData] keyed by a [RoleExperience]'s palette.
/// Idempotent — calling it twice with the same experience yields
/// equal themes (Material's `ColorScheme.fromSeed` is
/// deterministic).
ThemeData roleThemeFor(RoleExperience exp, {Brightness brightness = Brightness.light}) {
  final colorScheme = ColorScheme.fromSeed(
    seedColor: exp.primarySeed,
    brightness: brightness,
  );

  // The admin role gets a slate-on-primary AppBar so the
  // operator context is unmistakable. Customer + owner roles
  // keep the lighter surface-on-onSurface AppBar that's
  // friendlier for end users.
  final adminContext = exp.role == 'ADMIN';

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: colorScheme,
    visualDensity: VisualDensity.adaptivePlatformDensity,
    // Use the InkRipple splash instead of Material 3's default
    // InkSparkle. InkSparkle loads a runtime fragment shader
    // (`shaders/ink_sparkle.frag`) whose bundled manifest version
    // can mismatch a stale local Flutter engine cache — surfacing
    // in `flutter test` as "Unsupported runtime stages format
    // version. Expected 2, got 1." InkRipple is shader-free, so
    // the whole widget-test suite stops depending on the engine's
    // shader cache being in lock-step. Set centrally here (every
    // role theme flows through this builder) + in app.dart's base
    // theme so no per-test patching is needed.
    splashFactory: InkRipple.splashFactory,
    appBarTheme: AppBarTheme(
      backgroundColor:
          adminContext ? colorScheme.primary : colorScheme.surface,
      foregroundColor:
          adminContext ? colorScheme.onPrimary : colorScheme.onSurface,
      centerTitle: false,
      elevation: 0,
    ),
    // NavigationBar uses the primary container as the indicator
    // background, which under M3-fromSeed automatically aligns
    // with the seed colour family. No per-role override needed.
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: colorScheme.surface,
      indicatorColor: colorScheme.primaryContainer,
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        final base = TextStyle(
          color: colorScheme.onSurfaceVariant,
          fontWeight: FontWeight.w500,
        );
        if (states.contains(WidgetState.selected)) {
          return base.copyWith(
            color: colorScheme.onSurface,
            fontWeight: FontWeight.w600,
          );
        }
        return base;
      }),
    ),
    cardTheme: CardThemeData(
      elevation: 0,
      color: colorScheme.surfaceContainerHighest,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
    ),
  );
}
