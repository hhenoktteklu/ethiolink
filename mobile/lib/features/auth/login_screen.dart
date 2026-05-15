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
// The "EthioLink" branding + the environment badge in the bottom
// corner are intentionally placeholder-grade. The design pass
// replaces them with the real splash + onboarding flow in a
// later commit.

import 'package:flutter/material.dart';

import '../../core/auth/auth_service.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/browse_screen.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final AuthService _auth = FakeAuthService();
  bool _signingIn = false;
  String? _error;

  Future<void> _onSignInTapped() async {
    setState(() {
      _signingIn = true;
      _error = null;
    });
    try {
      final session = await _auth.signIn();
      if (!mounted) return;
      Navigator.of(context).pushReplacement(
        MaterialPageRoute<void>(
          builder: (_) => BrowseScreen(session: session),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = 'Sign in failed: $e';
        _signingIn = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = AppConfigScope.of(context);
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;

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
                      'EthioLink',
                      textAlign: TextAlign.center,
                      style: textTheme.displaySmall?.copyWith(
                        color: colors.primary,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      'Book salons, barbers, spas, and beauty pros across Ethiopia.',
                      textAlign: TextAlign.center,
                      style: textTheme.bodyMedium?.copyWith(
                        color: colors.onSurfaceVariant,
                      ),
                    ),
                    const SizedBox(height: 48),
                    FilledButton.icon(
                      onPressed: _signingIn ? null : _onSignInTapped,
                      icon: _signingIn
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                              ),
                            )
                          : const Icon(Icons.login),
                      label: Text(_signingIn ? 'Signing in…' : 'Sign in'),
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
