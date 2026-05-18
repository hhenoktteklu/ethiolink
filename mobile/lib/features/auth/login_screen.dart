// EthioLink Mobile — placeholder login screen.
//
// Phase 9 Track 3 scaffold. Tapping "Sign in" runs the
// `FakeAuthService` (defined in `lib/core/auth/auth_service.dart`),
// which simulates a 300 ms PKCE round-trip and pushes the
// placeholder home screen. The real Cognito hosted-UI flow lands
// in the next mobile commit; this screen's structure (button +
// loading state + error display) stays the same, only the
// underlying service swaps.
//
// Sign-in is a two-phase pipeline:
//
//   Phase 1 — Cognito OAuth. `AuthService.signIn()` opens the
//             hosted UI in a Chrome Custom Tab, completes the
//             PKCE round-trip, and persists the tokens in secure
//             storage so the `AuthTokenInterceptor` can attach
//             the ID token to subsequent calls.
//
//   Phase 2 — Backend user-row bootstrap. We POST `/v1/auth/sync`
//             which creates (or returns the existing) `users` row
//             in the application database. Skipping this step
//             surfaces as `404 NOT_FOUND ("User profile not found.
//             Call POST /v1/auth/sync first.")` on the first
//             protected call — historically the Bookings tab's
//             `GET /v1/me/appointments`.
//
// The two phases are tracked independently so a Phase-2 failure
// (network blip, transient 5xx) can be retried without forcing
// the user back through the Cognito browser flow. Only an actual
// `unauthenticated` failure routes back to "Sign in again".
//
// The "EthioLink" branding + the environment badge in the bottom
// corner are intentionally placeholder-grade. The design pass
// replaces them with the real splash + onboarding flow in a
// later commit.

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/auth_sync_repository.dart';
import '../../core/auth/cognito_auth_service.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/browse_screen.dart';

class LoginScreen extends StatefulWidget {
  /// Phase 9 — accepts an optional `AuthService` override so widget
  /// tests inject a `FakeAuthService` without booting the
  /// `flutter_appauth` platform channel. Production runs leave
  /// this `null`; the State initializes `CognitoAuthService` from
  /// `AppConfigScope` on `didChangeDependencies`.
  const LoginScreen({
    this.authServiceOverride,
    this.authSyncRepositoryOverride,
    super.key,
  });

  final AuthService? authServiceOverride;

  /// Test seam — production constructs an `HttpAuthSyncRepository`
  /// over an `ApiClient` after Phase 1 completes. Tests pass an
  /// in-memory fake to assert on call counts + drive failure
  /// branches without going through Dio.
  final AuthSyncRepository? authSyncRepositoryOverride;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

/// Tracks where in the sign-in pipeline we are so the right UI
/// state surfaces. `phase1Failed` / `phase2Failed` distinguish
/// the retry button copy + behaviour: phase-1 failures re-open
/// the OAuth flow, phase-2 failures just re-issue `sync()`.
enum _SignInPhase {
  /// Initial state — the Sign in button is enabled and no error
  /// is shown.
  idle,

  /// `AuthService.signIn()` is in flight (Chrome Custom Tab is
  /// presented). The button shows "Signing in…" and is disabled.
  phase1Authenticating,

  /// `AuthSyncRepository.sync()` is in flight. The button shows
  /// "Finishing sign-in…" so the user understands the
  /// authenticator already accepted them and we're talking to
  /// the backend.
  phase2Syncing,

  /// Phase-1 raised. The Sign in button re-enables; user can
  /// tap to try the OAuth flow again.
  phase1Failed,

  /// Phase-2 raised. A "Try again" button is shown that calls
  /// `sync()` only — no second OAuth round-trip required. If the
  /// underlying failure was `unauthenticated` we collapse back to
  /// phase-1 because the session needs re-establishing.
  phase2Failed,
}

class _LoginScreenState extends State<LoginScreen> {
  AuthService? _auth;
  AuthSyncRepository? _authSync;

  _SignInPhase _phase = _SignInPhase.idle;
  String? _error;

  /// Carried across phases. We hold the `AuthSession` from
  /// phase-1 so a phase-2 retry button can navigate forward
  /// without re-running phase-1.
  AuthSession? _pendingSession;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_auth != null) return;
    final config = AppConfigScope.of(context);
    if (widget.authServiceOverride != null) {
      _auth = widget.authServiceOverride;
    } else {
      // Production wiring: real Cognito service constructed from
      // the inherited `AppConfig`. The `AppConfigScope` lookup
      // belongs inside a build-context aware hook (init or
      // didChange…), not in the field initialiser — `context` is
      // not safe to read there.
      _auth = CognitoAuthService(config: config);
    }
    // Phase-2 wiring. Tests pass an `AuthSyncRepository` directly;
    // production constructs `HttpAuthSyncRepository` over an
    // `ApiClient` bound to the same `AppConfig`. The `ApiClient`'s
    // `AuthTokenInterceptor` will pick the bare Cognito ID token
    // out of secure storage on the outbound call (see
    // `api_client.dart`'s header rationale).
    _authSync = widget.authSyncRepositoryOverride ??
        HttpAuthSyncRepository(ApiClient(config: config));
  }

  bool get _busy =>
      _phase == _SignInPhase.phase1Authenticating ||
      _phase == _SignInPhase.phase2Syncing;

  Future<void> _onSignInTapped() async {
    final auth = _auth;
    final authSync = _authSync;
    if (auth == null || authSync == null) return;

    // Phase 1 — Cognito OAuth.
    setState(() {
      _phase = _SignInPhase.phase1Authenticating;
      _error = null;
      _pendingSession = null;
    });
    AuthSession session;
    try {
      session = await auth.signIn();
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _phase = _SignInPhase.phase1Failed;
        _error = 'Sign in failed: $e';
      });
      return;
    }
    if (!mounted) return;
    _pendingSession = session;

    // Phase 2 — backend user-row bootstrap.
    await _runSyncAndNavigate();
  }

  /// Phase-2 entry point. Also the "Try again" handler for the
  /// `phase2Failed` UI — the OAuth tokens are already in secure
  /// storage so we just re-issue `/v1/auth/sync`.
  Future<void> _runSyncAndNavigate() async {
    final authSync = _authSync;
    final session = _pendingSession;
    if (authSync == null || session == null) return;

    setState(() {
      _phase = _SignInPhase.phase2Syncing;
      _error = null;
    });
    try {
      await authSync.sync();
    } on AuthSyncFailure catch (e) {
      if (!mounted) return;
      setState(() {
        if (e.kind == AuthSyncFailureKind.unauthenticated) {
          // Session unusable — drop back to phase-1 so the user
          // re-authenticates instead of futilely retrying sync.
          _phase = _SignInPhase.phase1Failed;
          _error = 'Your session expired. Sign in again to continue.';
          _pendingSession = null;
        } else {
          _phase = _SignInPhase.phase2Failed;
          _error =
              "Couldn't finish setting up your account: ${e.message}";
        }
      });
      return;
    }
    if (!mounted) return;
    Navigator.of(context).pushReplacement(
      MaterialPageRoute<void>(
        builder: (_) => BrowseScreen(
          session: session,
          authServiceOverride: widget.authServiceOverride,
        ),
      ),
    );
  }

  /// CTA copy for the phase-1 button. The "Finishing sign-in…"
  /// branch makes it clear the OAuth round-trip already
  /// succeeded — useful when the backend bootstrap (`/v1/auth/sync`)
  /// is slow.
  String _ctaLabel(AppLocalizations l10n) {
    switch (_phase) {
      case _SignInPhase.phase1Authenticating:
        return l10n.loginSigningIn;
      case _SignInPhase.phase2Syncing:
        return 'Finishing sign-in…';
      case _SignInPhase.idle:
      case _SignInPhase.phase1Failed:
      case _SignInPhase.phase2Failed:
        return l10n.loginSignIn;
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = AppConfigScope.of(context);
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final l10n = AppLocalizations.of(context);

    return Scaffold(
      body: SafeArea(
        child: Stack(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: 24,
                vertical: 32,
              ),
              child: Center(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Icon(
                      Icons.spa_outlined,
                      size: 96,
                      color: colors.primary,
                    ),
                    const SizedBox(height: 24),
                    Text(
                      l10n.appTitle,
                      textAlign: TextAlign.center,
                      style: textTheme.displaySmall?.copyWith(
                        color: colors.primary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      l10n.appTagline,
                      textAlign: TextAlign.center,
                      style: textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 48),
                    // Primary CTA: phase-1 button. Hidden when
                    // phase-2 has its own retry — keeps a single
                    // affordance visible at any time so the user
                    // isn't presented with two buttons that map
                    // to different recovery paths.
                    if (_phase != _SignInPhase.phase2Failed)
                      FilledButton.icon(
                        onPressed: _busy ? null : _onSignInTapped,
                        icon: _busy
                            ? const SizedBox(
                                width: 16,
                                height: 16,
                                child: CircularProgressIndicator(
                                  strokeWidth: 2,
                                ),
                              )
                            : const Icon(Icons.login),
                        label: Text(_ctaLabel(l10n)),
                      ),
                    // Phase-2 retry — only re-runs `sync()`, no
                    // OAuth round-trip.
                    if (_phase == _SignInPhase.phase2Failed)
                      FilledButton.icon(
                        onPressed: _runSyncAndNavigate,
                        icon: const Icon(Icons.refresh),
                        label: const Text('Try again'),
                      ),
                    if (_error != null) ...[
                      const SizedBox(height: 16),
                      Text(
                        _error!,
                        textAlign: TextAlign.center,
                        style: textTheme.bodySmall?.copyWith(
                          color: colors.error,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            Positioned(
              left: 12,
              bottom: 12,
              child: _EnvBadge(env: config.environmentName),
            ),
          ],
        ),
      ),
    );
  }
}

class _EnvBadge extends StatelessWidget {
  const _EnvBadge({required this.env});

  final String env;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        env.toUpperCase(),
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colors.onSurfaceVariant,
              letterSpacing: 0.5,
            ),
      ),
    );
  }
}
