// EthioLink Mobile — auth service abstraction.
//
// The scaffold defines the port that the placeholder login screen
// uses: an `AuthService` with `signIn` / `signOut` / `currentSession`.
// The real implementation lands in the next mobile commit and
// uses `flutter_appauth` (or `amplify_auth_cognito`, decided at
// the time) to drive the Cognito PKCE flow against
// `${cognitoDomain}/oauth2/authorize` with the
// `com.ethiolink.app:/oauthredirect` reverse-domain redirect URI.
//
// The scaffold ships a `FakeAuthService` that records each
// invocation and simulates a successful sign-in after a 300 ms
// delay. The placeholder login screen wires this fake so the UX
// loop ("tap Sign in → land on home") works end-to-end without
// any real network call. Replacing it is a one-line swap in
// `app.dart` once the Cognito wiring lands.

import 'dart:async';

/// Session shape the rest of the app reads. Mirrors the JWT
/// claims the production app will extract from the Cognito ID
/// token. The placeholder populates a stub identity.
class AuthSession {
  const AuthSession({
    required this.userId,
    required this.email,
    required this.role,
    required this.expiresAt,
  });

  final String userId;
  final String email;
  final String role; // 'CUSTOMER' | 'BUSINESS_OWNER' | 'ADMIN'
  final DateTime expiresAt;
}

abstract class AuthService {
  /// Initiate the PKCE flow. Real implementation launches the
  /// system browser (or in-app browser tab) at the hosted-UI
  /// authorize endpoint and returns once the deep-link callback
  /// resolves. Throws on user cancellation or network failure.
  Future<AuthSession> signIn();

  /// Clear the session locally and call the hosted-UI logout
  /// endpoint so subsequent sign-ins land on the email/password
  /// screen rather than auto-resuming a previous session.
  Future<void> signOut();

  /// Returns the cached session when one is present, otherwise
  /// `null`. The placeholder always returns `null` so the app
  /// boots into the login screen.
  Future<AuthSession?> currentSession();
}

/// Placeholder implementation. Used everywhere in the scaffold;
/// replaced wholesale by `CognitoAuthService` in the next mobile
/// commit.
class FakeAuthService implements AuthService {
  FakeAuthService();

  AuthSession? _session;

  @override
  Future<AuthSession> signIn() async {
    await Future<void>.delayed(const Duration(milliseconds: 300));
    final session = AuthSession(
      userId: 'fake-user-id',
      email: 'demo@ethiolink.app',
      role: 'CUSTOMER',
      expiresAt: DateTime.now().add(const Duration(hours: 1)),
    );
    _session = session;
    return session;
  }

  @override
  Future<void> signOut() async {
    _session = null;
  }

  @override
  Future<AuthSession?> currentSession() async => _session;
}
