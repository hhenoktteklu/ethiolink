// EthioLink Mobile — LinkTelegramScreen widget tests.
//
// Drives the screen end-to-end against an in-memory
// `TelegramLinkRepository` fake + a recording `LinkLauncher`.
// Polling uses a tiny `Duration` so the test suite stays fast.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/profile/data/telegram_link_repository.dart';
import 'package:ethiolink/features/profile/link_telegram_screen.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'ethiolink://auth/callback',
);

class _FakeRepo implements TelegramLinkRepository {
  _FakeRepo();

  TelegramLinkStatus initialStatus =
      const TelegramLinkStatus(linked: false, linkedAt: null);
  TelegramLinkStatus? afterStartStatus;
  TelegramLinkStart startResult = const TelegramLinkStart(
    deepLink: 'https://t.me/EthioLinkBot?start=ABCDEF',
    expiresAt: '2026-05-15T10:30:00.000Z',
  );
  Object? statusError;
  Object? startError;
  Object? unlinkError;

  int statusCalls = 0;
  int startCalls = 0;
  int unlinkCalls = 0;

  @override
  Future<TelegramLinkStart> startLink() async {
    startCalls += 1;
    if (startError != null) throw startError!;
    return startResult;
  }

  @override
  Future<TelegramLinkStatus> getStatus() async {
    statusCalls += 1;
    if (statusError != null) throw statusError!;
    if (afterStartStatus != null && startCalls > 0) return afterStartStatus!;
    return initialStatus;
  }

  @override
  Future<void> unlink() async {
    unlinkCalls += 1;
    if (unlinkError != null) throw unlinkError!;
  }
}

class _RecordingLauncher {
  final List<String> calls = [];
  bool returns = true;
  Future<bool> launch(String url) async {
    calls.add(url);
    return returns;
  }
}

Future<void> _pump(
  WidgetTester tester, {
  required TelegramLinkRepository repo,
  required LinkLauncher launcher,
  Duration pollInterval = const Duration(milliseconds: 10),
  int pollMaxAttempts = 10,
}) async {
  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        home: LinkTelegramScreen(
          repositoryOverride: repo,
          linkLauncherOverride: launcher,
          pollInterval: pollInterval,
          pollMaxAttempts: pollMaxAttempts,
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('renders the not-linked branch on mount', (tester) async {
    final repo = _FakeRepo();
    final launcher = _RecordingLauncher();
    await _pump(tester, repo: repo, launcher: launcher.launch);

    expect(find.text('Link Telegram'), findsOneWidget);
    expect(repo.statusCalls, 1);
  });

  testWidgets('renders the linked branch when status is linked',
      (tester) async {
    final repo = _FakeRepo()
      ..initialStatus = const TelegramLinkStatus(
        linked: true,
        linkedAt: '2026-05-15T09:42:00.000Z',
      );
    final launcher = _RecordingLauncher();
    await _pump(tester, repo: repo, launcher: launcher.launch);

    expect(find.text('Telegram is linked'), findsOneWidget);
    expect(find.widgetWithText(OutlinedButton, 'Unlink Telegram'),
        findsOneWidget);
    expect(find.textContaining('2026-05-15T09:42'), findsOneWidget);
  });

  testWidgets('renders the unconfigured branch on a 503 status', (tester) async {
    final repo = _FakeRepo()
      ..statusError = TelegramLinkFailure(
        kind: TelegramLinkFailureKind.unconfigured,
        message: 'Telegram integration is not configured for this environment.',
        statusCode: 503,
      );
    final launcher = _RecordingLauncher();
    await _pump(tester, repo: repo, launcher: launcher.launch);

    expect(find.text('Telegram is not yet enabled'), findsOneWidget);
    // No Link button on the unconfigured branch.
    expect(find.widgetWithText(FilledButton, 'Link Telegram'), findsNothing);
  });

  testWidgets('renders the error branch on a generic failure',
      (tester) async {
    final repo = _FakeRepo()
      ..statusError = TelegramLinkFailure(
        kind: TelegramLinkFailureKind.network,
        message: 'fetch failed',
      );
    final launcher = _RecordingLauncher();
    await _pump(tester, repo: repo, launcher: launcher.launch);

    expect(find.text('Could not load Telegram status'), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });

  testWidgets('Link Telegram → start + launches deep link + polls to linked',
      (tester) async {
    final repo = _FakeRepo();
    repo.afterStartStatus = const TelegramLinkStatus(
      linked: true,
      linkedAt: '2026-05-15T10:00:00.000Z',
    );
    final launcher = _RecordingLauncher();
    await _pump(
      tester,
      repo: repo,
      launcher: launcher.launch,
      pollInterval: const Duration(milliseconds: 10),
    );

    await tester.tap(find.widgetWithText(FilledButton, 'Link Telegram'));
    // start → launch → schedule poll. Pump for the polling tick.
    await tester.pump(); // start completes
    await tester.pump(const Duration(milliseconds: 12));
    await tester.pump();

    expect(repo.startCalls, 1);
    expect(launcher.calls, ['https://t.me/EthioLinkBot?start=ABCDEF']);

    // Drain the timer + any in-flight microtasks.
    await tester.pumpAndSettle();
    expect(find.text('Telegram is linked'), findsOneWidget);
  });

  testWidgets('Manual "check now" during polling pulls the latest status',
      (tester) async {
    final repo = _FakeRepo();
    final launcher = _RecordingLauncher();
    await _pump(
      tester,
      repo: repo,
      launcher: launcher.launch,
      // Big interval so the periodic timer doesn't fire during the
      // test — we drive the check via the manual button.
      pollInterval: const Duration(seconds: 30),
    );

    await tester.tap(find.widgetWithText(FilledButton, 'Link Telegram'));
    await tester.pumpAndSettle();

    // Mid-poll: server now reports linked.
    repo.afterStartStatus = const TelegramLinkStatus(
      linked: true,
      linkedAt: '2026-05-15T10:00:00.000Z',
    );

    await tester.tap(
      find.widgetWithText(FilledButton, 'I linked it — check now'),
    );
    await tester.pumpAndSettle();

    expect(find.text('Telegram is linked'), findsOneWidget);
  });

  testWidgets('Cancel during polling returns to the not-linked branch',
      (tester) async {
    final repo = _FakeRepo();
    final launcher = _RecordingLauncher();
    await _pump(
      tester,
      repo: repo,
      launcher: launcher.launch,
      pollInterval: const Duration(seconds: 30),
    );

    await tester.tap(find.widgetWithText(FilledButton, 'Link Telegram'));
    await tester.pumpAndSettle();

    expect(find.text('Waiting for Telegram confirmation…'), findsOneWidget);

    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();

    expect(find.text('Link Telegram'), findsOneWidget);
  });

  testWidgets('Launch failure shows the "Telegram not installed" hint',
      (tester) async {
    final repo = _FakeRepo();
    final launcher = _RecordingLauncher()..returns = false;
    await _pump(tester, repo: repo, launcher: launcher.launch);

    await tester.tap(find.widgetWithText(FilledButton, 'Link Telegram'));
    await tester.pumpAndSettle();

    expect(repo.startCalls, 1);
    expect(launcher.calls, isNotEmpty);
    expect(find.textContaining('Could not open Telegram'), findsOneWidget);
    // Still on the not-linked branch so the user can retry.
    expect(find.widgetWithText(FilledButton, 'Link Telegram'), findsOneWidget);
  });

  testWidgets('Unlink calls the repo and renders the not-linked branch',
      (tester) async {
    final repo = _FakeRepo()
      ..initialStatus = const TelegramLinkStatus(
        linked: true,
        linkedAt: '2026-05-15T09:42:00.000Z',
      );
    final launcher = _RecordingLauncher();
    await _pump(tester, repo: repo, launcher: launcher.launch);

    await tester
        .tap(find.widgetWithText(OutlinedButton, 'Unlink Telegram'));
    await tester.pumpAndSettle();

    expect(repo.unlinkCalls, 1);
    expect(find.text('Link Telegram'), findsOneWidget);
  });

  testWidgets('Try again from the error branch refetches status',
      (tester) async {
    final repo = _FakeRepo();
    final launcher = _RecordingLauncher();

    // First status call fails.
    repo.statusError = TelegramLinkFailure(
      kind: TelegramLinkFailureKind.network,
      message: 'flaky',
    );
    await _pump(tester, repo: repo, launcher: launcher.launch);
    expect(find.text('Could not load Telegram status'), findsOneWidget);

    // Recover.
    repo.statusError = null;
    repo.initialStatus =
        const TelegramLinkStatus(linked: false, linkedAt: null);

    await tester.tap(find.widgetWithText(FilledButton, 'Try again'));
    await tester.pumpAndSettle();

    expect(find.text('Link Telegram'), findsOneWidget);
    expect(repo.statusCalls, 2);
  });

  testWidgets(
      'poll-exhaustion branch shows after pollMaxAttempts unsuccessful polls',
      (tester) async {
    final repo = _FakeRepo();
    // Status stays not-linked forever during polling.
    final launcher = _RecordingLauncher();
    await _pump(
      tester,
      repo: repo,
      launcher: launcher.launch,
      pollInterval: const Duration(milliseconds: 5),
      pollMaxAttempts: 3,
    );

    await tester.tap(find.widgetWithText(FilledButton, 'Link Telegram'));
    await tester.pumpAndSettle();

    // Let the timer fire enough times to exhaust attempts.
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 6));
    }
    await tester.pumpAndSettle();

    expect(find.text("Didn't see the confirmation"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Check now'), findsOneWidget);
  });
}
