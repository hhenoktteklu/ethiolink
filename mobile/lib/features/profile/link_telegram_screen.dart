// EthioLink Mobile — Telegram linking screen.
//
// Phase 9 Track 2 mobile UI commit. Reached from the Profile
// tab's "Notifications" section. Drives the three Telegram link
// endpoints over `TelegramLinkRepository`:
//
//   * On mount: load status. Five terminal states:
//       - loading                 → spinner.
//       - not linked              → "Link Telegram" CTA.
//       - linked                  → linkedAt + "Unlink" CTA.
//       - unconfigured (503)      → "Telegram is not yet enabled
//                                   in this environment" message.
//       - error (network / other) → retry CTA.
//   * Tap "Link Telegram"         → POST start → open deep link
//                                   via the injected
//                                   `LinkLauncher` → start polling
//                                   `getStatus` every 3 seconds
//                                   for up to 90 seconds OR until
//                                   `linked == true`.
//   * "I linked it — check now"   → manual refresh button shown
//                                   alongside the timer status.
//   * Tap "Unlink"                → DELETE /me/link-telegram →
//                                   show not-linked state.
//
// Test seams (constructor overrides):
//   * `repositoryOverride`  — fake repo for every API call.
//   * `linkLauncherOverride`— recording function instead of
//                             url_launcher (which needs platform
//                             channels).
//   * `pollInterval`        — defaults to 3 s; tests pass smaller
//                             values so polling tests run fast.
//   * `pollMaxAttempts`     — defaults to 30 (30 × 3 s = 90 s).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import 'data/telegram_link_repository.dart';

/// `Future<bool>` mirrors `url_launcher`'s `launchUrl` return —
/// `true` when the OS accepted the URL, `false` when it refused
/// (e.g. Telegram not installed). The screen branches on the
/// result to show a "Telegram is not installed" hint.
typedef LinkLauncher = Future<bool> Function(String url);

/// Production launcher — wraps `url_launcher.launchUrl`.
Future<bool> _defaultLinkLauncher(String url) async {
  final uri = Uri.parse(url);
  return launchUrl(uri, mode: LaunchMode.externalApplication);
}

class LinkTelegramScreen extends StatefulWidget {
  const LinkTelegramScreen({
    this.repositoryOverride,
    this.linkLauncherOverride,
    this.pollInterval = const Duration(seconds: 3),
    this.pollMaxAttempts = 30,
    super.key,
  });

  /// Test seam — production constructs `HttpTelegramLinkRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final TelegramLinkRepository? repositoryOverride;

  /// Test seam — production uses `url_launcher`'s `launchUrl`.
  final LinkLauncher? linkLauncherOverride;

  /// Time between status polls during a link attempt. Production
  /// defaults to 3 seconds.
  final Duration pollInterval;

  /// Maximum number of status polls before the screen gives up
  /// and shows a "didn't see the link confirm — tap to retry"
  /// hint. Production defaults to 30 (90 s wall-clock).
  final int pollMaxAttempts;

  @override
  State<LinkTelegramScreen> createState() => _LinkTelegramScreenState();
}

enum _Phase {
  loading,
  notLinked,
  linked,
  unconfigured,
  error,
  startInFlight,
  polling,
  pollExhausted,
  unlinkInFlight,
}

class _LinkTelegramScreenState extends State<LinkTelegramScreen> {
  TelegramLinkRepository? _repo;
  late final LinkLauncher _launcher;

  _Phase _phase = _Phase.loading;
  TelegramLinkStatus? _status;
  TelegramLinkStart? _pending;
  TelegramLinkFailure? _error;

  Timer? _pollTimer;
  int _pollAttempt = 0;

  @override
  void initState() {
    super.initState();
    _launcher = widget.linkLauncherOverride ?? _defaultLinkLauncher;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpTelegramLinkRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _loadStatus();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    super.dispose();
  }

  // ---------------- state transitions ----------------

  Future<void> _loadStatus() async {
    setState(() {
      _phase = _Phase.loading;
      _error = null;
    });
    try {
      final status = await _repo!.getStatus();
      if (!mounted) return;
      setState(() {
        _status = status;
        _phase = status.linked ? _Phase.linked : _Phase.notLinked;
      });
    } on TelegramLinkFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _phase = e.kind == TelegramLinkFailureKind.unconfigured
            ? _Phase.unconfigured
            : _Phase.error;
      });
    }
  }

  Future<void> _startLink() async {
    setState(() {
      _phase = _Phase.startInFlight;
      _error = null;
    });
    try {
      final started = await _repo!.startLink();
      if (!mounted) return;
      _pending = started;
      final launched = await _launcher(started.deepLink);
      if (!mounted) return;
      if (!launched) {
        // OS refused the URL — most likely Telegram isn't
        // installed. Bounce back to not-linked so the user can
        // retry after installing.
        setState(() {
          _phase = _Phase.notLinked;
          _error = TelegramLinkFailure(
              kind: TelegramLinkFailureKind.other,
              message:
                  'Could not open Telegram. Make sure the app is installed.');
        });
        return;
      }
      _beginPolling();
    } on TelegramLinkFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _phase = e.kind == TelegramLinkFailureKind.unconfigured
            ? _Phase.unconfigured
            : _Phase.error;
      });
    }
  }

  void _beginPolling() {
    _pollAttempt = 0;
    setState(() => _phase = _Phase.polling);
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(widget.pollInterval, (_) {
      _pollOnce();
    });
  }

  Future<void> _pollOnce() async {
    if (!mounted) {
      _pollTimer?.cancel();
      return;
    }
    _pollAttempt += 1;
    try {
      final status = await _repo!.getStatus();
      if (!mounted) {
        _pollTimer?.cancel();
        return;
      }
      if (status.linked) {
        _pollTimer?.cancel();
        setState(() {
          _status = status;
          _phase = _Phase.linked;
        });
        return;
      }
      if (_pollAttempt >= widget.pollMaxAttempts) {
        _pollTimer?.cancel();
        setState(() => _phase = _Phase.pollExhausted);
      }
    } on TelegramLinkFailure catch (e) {
      _pollTimer?.cancel();
      if (!mounted) return;
      setState(() {
        _error = e;
        _phase = _Phase.error;
      });
    }
  }

  Future<void> _manualCheck() async {
    _pollTimer?.cancel();
    await _loadStatus();
  }

  Future<void> _unlink() async {
    setState(() {
      _phase = _Phase.unlinkInFlight;
      _error = null;
    });
    try {
      await _repo!.unlink();
      if (!mounted) return;
      setState(() {
        _status = const TelegramLinkStatus(linked: false, linkedAt: null);
        _phase = _Phase.notLinked;
      });
    } on TelegramLinkFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e;
        _phase = _Phase.error;
      });
    }
  }

  // ---------------- build ----------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Telegram notifications')),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: _body(),
        ),
      ),
    );
  }

  Widget _body() {
    switch (_phase) {
      case _Phase.loading:
      case _Phase.startInFlight:
      case _Phase.unlinkInFlight:
        return const Center(child: CircularProgressIndicator());
      case _Phase.unconfigured:
        return _UnconfiguredBanner();
      case _Phase.error:
        return _ErrorBranch(
          error: _error,
          onRetry: _loadStatus,
        );
      case _Phase.notLinked:
        return _NotLinkedBranch(
          error: _error,
          onLink: _startLink,
        );
      case _Phase.linked:
        return _LinkedBranch(
          linkedAt: _status?.linkedAt,
          onUnlink: _unlink,
        );
      case _Phase.polling:
        return _PollingBranch(
          deepLink: _pending?.deepLink ?? '',
          onCheckNow: _manualCheck,
          onCancel: _cancelPolling,
        );
      case _Phase.pollExhausted:
        return _PollExhaustedBranch(
          onCheckNow: _manualCheck,
          onRetryLink: _startLink,
        );
    }
  }

  void _cancelPolling() {
    _pollTimer?.cancel();
    setState(() => _phase = _Phase.notLinked);
  }
}

// ---------------------------------------------------------------------------
// Sub-widgets — one per terminal phase
// ---------------------------------------------------------------------------

class _NotLinkedBranch extends StatelessWidget {
  const _NotLinkedBranch({required this.error, required this.onLink});
  final TelegramLinkFailure? error;
  final VoidCallback onLink;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(Icons.telegram, size: 80, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'Link Telegram for booking notifications',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 8),
        Text(
          'Get real-time booking updates in Telegram. We will open '
          'a chat with our bot — tap Start to confirm the link.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        if (error != null) ...[
          const SizedBox(height: 12),
          _InlineError(error: error!),
        ],
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: onLink,
          icon: const Icon(Icons.link),
          label: const Text('Link Telegram'),
        ),
      ],
    );
  }
}

class _LinkedBranch extends StatelessWidget {
  const _LinkedBranch({required this.linkedAt, required this.onUnlink});
  final String? linkedAt;
  final VoidCallback onUnlink;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(Icons.check_circle, size: 80, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'Telegram is linked',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        if (linkedAt != null)
          Text(
            'Last updated: $linkedAt',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onSurfaceVariant,
                ),
          ),
        const SizedBox(height: 24),
        OutlinedButton.icon(
          onPressed: onUnlink,
          icon: const Icon(Icons.link_off),
          label: const Text('Unlink Telegram'),
        ),
      ],
    );
  }
}

class _PollingBranch extends StatelessWidget {
  const _PollingBranch({
    required this.deepLink,
    required this.onCheckNow,
    required this.onCancel,
  });
  final String deepLink;
  final VoidCallback onCheckNow;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const SizedBox(height: 8),
        const Center(child: CircularProgressIndicator()),
        const SizedBox(height: 16),
        Text(
          'Waiting for Telegram confirmation…',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Open the Telegram conversation and tap Start. We will '
          'update this screen automatically when the link lands.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 24),
        FilledButton.tonalIcon(
          onPressed: onCheckNow,
          icon: const Icon(Icons.refresh),
          label: const Text('I linked it — check now'),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: onCancel,
          child: const Text('Cancel'),
        ),
      ],
    );
  }
}

class _PollExhaustedBranch extends StatelessWidget {
  const _PollExhaustedBranch({
    required this.onCheckNow,
    required this.onRetryLink,
  });
  final VoidCallback onCheckNow;
  final VoidCallback onRetryLink;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(Icons.hourglass_disabled, size: 64, color: colors.error),
        const SizedBox(height: 12),
        Text(
          "Didn't see the confirmation",
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'If you tapped Start in Telegram, the link may have '
          'already landed — tap "Check now". Otherwise restart the '
          'flow.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: onCheckNow,
          icon: const Icon(Icons.refresh),
          label: const Text('Check now'),
        ),
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: onRetryLink,
          icon: const Icon(Icons.replay),
          label: const Text('Restart linking'),
        ),
      ],
    );
  }
}

class _UnconfiguredBanner extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(Icons.notifications_off, size: 64, color: colors.onSurfaceVariant),
        const SizedBox(height: 12),
        Text(
          'Telegram is not yet enabled',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'The operator has not configured a Telegram bot for this '
          'environment. Booking notifications continue via SMS '
          '(when available).',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
      ],
    );
  }
}

class _ErrorBranch extends StatelessWidget {
  const _ErrorBranch({required this.error, required this.onRetry});
  final TelegramLinkFailure? error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isNetwork =
        error?.kind == TelegramLinkFailureKind.network;
    final body = isNetwork
        ? "Can't reach the server. Check your connection and retry."
        : (error?.message ?? 'Something went wrong.');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Icon(
          isNetwork ? Icons.wifi_off : Icons.error_outline,
          size: 64,
          color: colors.error,
        ),
        const SizedBox(height: 12),
        Text(
          'Could not load Telegram status',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          body,
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 24),
        FilledButton.icon(
          onPressed: onRetry,
          icon: const Icon(Icons.refresh),
          label: const Text('Try again'),
        ),
      ],
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.error});
  final TelegramLinkFailure error;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        error.message,
        style: Theme.of(context).textTheme.bodySmall?.copyWith(
              color: colors.onErrorContainer,
            ),
      ),
    );
  }
}
