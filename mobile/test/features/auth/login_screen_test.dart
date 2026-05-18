// EthioLink Mobile — LoginScreen sign-in pipeline tests.
//
// Confirms the two-phase pipeline (Cognito OAuth → POST
// /v1/auth/sync) the production login screen drives. The
// regression we're guarding against:
//
//   Bookings tab failed with
//     `AppointmentHistoryLoadFailure: User profile not found.
//      Call POST /v1/auth/sync first.`
//   because the backend `users` row hadn't been created.
//   `/v1/auth/sync` had no client wiring; nothing called it
//   after Cognito completed.
//
// The tests pin the new contract:
//
//   1. After phase-1 (OAuth) succeeds and tokens are persisted,
//      the login screen issues `AuthSyncRepository.sync()`
//      BEFORE navigating to the authenticated shell.
//   2. While the sync is in flight, the UI shows
//      "Finishing sign-in…" so the user understands we're past
//      the browser handshake.
//   3. Phase-2 failures present a "Try again" button that
//      re-issues `sync()` only — no second OAuth round-trip.
//   4. Phase-2 `unauthenticated` failures collapse back to
//      phase-1 with the "Sign in again" CTA — retrying sync is
//      futile when the session is dead.
//   5. Phase-1 failures never call sync.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/auth/auth_service.dart';
import 'package:ethiolink/core/auth/auth_sync_repository.dart';
import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/auth/login_screen.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
  environmentName: 'test',
);

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/// `AuthService` that completes `signIn()` immediately with a
/// stub session, no platform channels. Different from the prod
/// `FakeAuthService` only in that there's no 300 ms delay — the
/// test runs in synchronous time.
class _ImmediateAuthService implements AuthService {
  int signInCalls = 0;

  @override
  Future<AuthSession> signIn() async {
    signInCalls += 1;
    return AuthSession(
      userId: 'sub-1',
      email: 'demo@ethiolink.app',
      role: 'CUSTOMER',
      expiresAt: DateTime.utc(2030),
    );
  }

  @override
  Future<void> signOut() async {}

  @override
  Future<AuthSession?> currentSession() async => null;
}

/// `AuthService` whose `signIn` always throws — exercises the
/// phase-1 failure branch.
class _ErroringAuthService implements AuthService {
  @override
  Future<AuthSession> signIn() async {
    throw Exception('Cognito browser cancelled');
  }

  @override
  Future<void> signOut() async {}

  @override
  Future<AuthSession?> currentSession() async => null;
}

/// `AuthSyncRepository` whose `sync()` future never completes.
/// Lets the test snapshot the "Finishing sign-in…" affordance
/// without triggering the post-sync navigation (BrowseScreen
/// brings in real Dio + secure-storage platform channels we
/// deliberately avoid here).
class _StuckSyncRepository implements AuthSyncRepository {
  int callCount = 0;

  @override
  Future<void> sync() {
    callCount += 1;
    return Completer<void>().future;
  }
}

class _RecordingSyncRepository implements AuthSyncRepository {
  _RecordingSyncRepository({this.failure});

  int callCount = 0;
  final AuthSyncFailure? failure;

  @override
  Future<void> sync() async {
    callCount += 1;
    final f = failure;
    if (f != null) throw f;
  }
}

// ---------------------------------------------------------------------------
// Test scaffolding
// ---------------------------------------------------------------------------

Future<void> _pumpLogin(
  WidgetTester tester, {
  required AuthService auth,
  required AuthSyncRepository sync,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: LoginScreen(
          authServiceOverride: auth,
          authSyncRepositoryOverride: sync,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

void main() {
  testWidgets(
    'tapping Sign in runs Phase 1 then Phase 2 — sync is called once',
    (tester) async {
      final auth = _ImmediateAuthService();
      final sync = _StuckSyncRepository();

      await _pumpLogin(tester, auth: auth, sync: sync);
      await tester.tap(find.text('Sign in'));
      // Let phase-1 resolve and phase-2 start. We deliberately
      // do NOT `pumpAndSettle` because the stuck sync future
      // would block forever — bounded pumps keep the test
      // deterministic.
      await tester.pump();
      await tester.pump();

      expect(auth.signInCalls, 1);
      expect(sync.callCount, 1);
      // While sync is in flight the CTA copy clarifies we're
      // past the browser handshake.
      expect(find.text('Finishing sign-in…'), findsOneWidget);
      // Still on the login screen — BrowseScreen push only fires
      // after sync resolves.
      expect(find.byType(LoginScreen), findsOneWidget);
    },
  );

  testWidgets('phase-2 network failure surfaces an error + Try again CTA',
      (tester) async {
    final auth = _ImmediateAuthService();
    final sync = _RecordingSyncRepository(
      failure: AuthSyncFailure(
        kind: AuthSyncFailureKind.network,
        message: 'connection timed out',
      ),
    );

    await _pumpLogin(tester, auth: auth, sync: sync);
    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();

    expect(auth.signInCalls, 1);
    expect(sync.callCount, 1);
    // Phase-2 retry CTA (not phase-1) — the OAuth tokens are
    // already in secure storage; re-running OAuth would be
    // wasted effort.
    expect(find.text('Try again'), findsOneWidget);
    expect(find.text('Sign in'), findsNothing);
    expect(
      find.textContaining("Couldn't finish setting up your account"),
      findsOneWidget,
    );
  });

  testWidgets('phase-2 Try again re-issues sync() without re-running OAuth',
      (tester) async {
    // First sync throws network failure; second one succeeds.
    // The success path would normally navigate to BrowseScreen,
    // which pulls in platform channels — we don't `pumpAndSettle`
    // on the second sync so the navigation hasn't fired yet by
    // the time we read sync.callCount.
    final auth = _ImmediateAuthService();
    int syncAttempt = 0;
    final sync = _ProgrammableSyncRepository(() async {
      syncAttempt += 1;
      if (syncAttempt == 1) {
        throw AuthSyncFailure(
          kind: AuthSyncFailureKind.network,
          message: 'connection timed out',
        );
      }
      // 2nd attempt: return a future that never resolves so the
      // post-sync navigation doesn't fire inside the test.
      return Completer<void>().future;
    });

    await _pumpLogin(tester, auth: auth, sync: sync);
    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();
    expect(syncAttempt, 1);

    await tester.tap(find.text('Try again'));
    await tester.pump();
    await tester.pump();

    // Phase-1 (OAuth) was NOT re-run — second attempt was sync only.
    expect(auth.signInCalls, 1);
    expect(syncAttempt, 2);
    // CTA copy is back to "Finishing sign-in…" while sync is
    // pending.
    expect(find.text('Finishing sign-in…'), findsOneWidget);
  });

  testWidgets(
    'phase-2 unauthenticated failure collapses back to phase-1 with Sign in',
    (tester) async {
      final auth = _ImmediateAuthService();
      final sync = _RecordingSyncRepository(
        failure: AuthSyncFailure(
          kind: AuthSyncFailureKind.unauthenticated,
          message: 'token rejected',
          statusCode: 401,
        ),
      );

      await _pumpLogin(tester, auth: auth, sync: sync);
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();

      expect(sync.callCount, 1);
      // Back to the phase-1 CTA — the session is unusable.
      expect(find.text('Sign in'), findsOneWidget);
      expect(find.text('Try again'), findsNothing);
      expect(
        find.textContaining('Your session expired'),
        findsOneWidget,
      );
    },
  );

  testWidgets('phase-1 failure never calls sync', (tester) async {
    final auth = _ErroringAuthService();
    final sync = _RecordingSyncRepository();

    await _pumpLogin(tester, auth: auth, sync: sync);
    await tester.tap(find.text('Sign in'));
    await tester.pumpAndSettle();

    expect(sync.callCount, 0,
        reason:
            'sync() must not run when Cognito sign-in failed — the '
            'interceptor would have no token to attach and the call '
            'would just hit the API Gateway authorizer with nothing.');
    expect(find.textContaining('Sign in failed'), findsOneWidget);
    // Phase-1 retry — the button reverts to "Sign in".
    expect(find.text('Sign in'), findsOneWidget);
  });
}

// ---------------------------------------------------------------------------
// Programmable sync — declared at the bottom so the test cases
// above read top-to-bottom. Lets a single test drive a multi-
// attempt sequence without juggling Completer state inline.
// ---------------------------------------------------------------------------

class _ProgrammableSyncRepository implements AuthSyncRepository {
  _ProgrammableSyncRepository(this._next);
  final Future<void> Function() _next;
  @override
  Future<void> sync() => _next();
}
