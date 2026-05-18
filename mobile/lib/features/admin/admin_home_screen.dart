// EthioLink Mobile — ADMIN role landing.
//
// The mobile app deliberately does NOT host admin write
// operations — those live in the admin web SPA per the Phase 9
// Track 3.5 design. This screen is an honest informational
// landing for ADMIN principals signed into the mobile app:
//
//   * A hero card explaining where the real admin tools live.
//   * A row of status cards showing the operator's own session
//     facts (role, email, environment, API base URL) so they
//     can sanity-check which environment they're pointed at
//     before opening the web console.
//   * A read-only "Open admin web console" affordance that
//     copies the env-derived URL — we don't try to launch it
//     because Cognito SSO across mobile<->browser is not wired
//     today and tapping a dead deep link is worse than the
//     honest message.
//
// The screen does NOT call any backend endpoint. The only
// information it surfaces is already in `AuthSession` +
// `AppConfig`, both of which are platform-channel-free, so the
// widget test for this screen is trivially pumpable.

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/auth/auth_service.dart';
import '../../core/config/app_config.dart';
import '../../core/config/app_config_scope.dart';
import '../../core/role/role_experience.dart';

class AdminHomeScreen extends StatelessWidget {
  const AdminHomeScreen({required this.session, super.key});

  final AuthSession session;

  /// Resolve the admin SPA URL from the environment name. The
  /// admin SPA is hosted at `https://admin-${env}.ethiolink.app`
  /// per the Phase 7 admin-frontend Terraform module. For an
  /// unknown env we fall back to the prod URL — the operator
  /// should never see this in dev/staging because the env name
  /// is always set from `--dart-define-from-file=env/<env>.json`.
  String _adminConsoleUrlFor(AppConfig config) {
    final env = config.environmentName.toLowerCase();
    switch (env) {
      case 'prod':
        return 'https://admin.ethiolink.app';
      default:
        return 'https://admin-$env.ethiolink.app';
    }
  }

  @override
  Widget build(BuildContext context) {
    final config = AppConfigScope.of(context);
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    const exp = RoleExperience.admin;
    final consoleUrl = _adminConsoleUrlFor(config);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Admin'),
        actions: [
          _RoleChip(label: exp.label),
          const SizedBox(width: 12),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
        children: [
          // Hero: where the real admin tools live.
          Card(
            color: colors.primaryContainer,
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        Icons.shield_outlined,
                        color: colors.onPrimaryContainer,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          'Admin tools live in the web console',
                          style: textTheme.titleMedium?.copyWith(
                            color: colors.onPrimaryContainer,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  Text(
                    'The mobile app gives you the customer-facing view of the '
                    'marketplace plus this status panel. Approvals, suspensions, '
                    'category management, payment reconciliation, and notification '
                    'logs all live in the admin web SPA.',
                    style: textTheme.bodyMedium?.copyWith(
                      color: colors.onPrimaryContainer,
                    ),
                  ),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      FilledButton.tonalIcon(
                        onPressed: () async {
                          await Clipboard.setData(
                            ClipboardData(text: consoleUrl),
                          );
                          if (!context.mounted) return;
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(
                              content: Text(
                                'Admin console URL copied to clipboard.',
                              ),
                              duration: Duration(seconds: 3),
                            ),
                          );
                        },
                        icon: const Icon(Icons.copy_outlined),
                        label: const Text('Copy console URL'),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Text(
                          consoleUrl,
                          style: textTheme.bodySmall?.copyWith(
                            color: colors.onPrimaryContainer,
                          ),
                          softWrap: true,
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ),

          const SizedBox(height: 24),
          Text(
            'Session',
            style: textTheme.titleSmall?.copyWith(
              color: colors.onSurfaceVariant,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: 8),

          // Status cards — read-only context for the operator.
          _StatusRow(
            icon: Icons.person_outline,
            label: 'Signed in as',
            value: session.email,
          ),
          _StatusRow(
            icon: Icons.verified_user_outlined,
            label: 'Role',
            value: session.role,
          ),
          _StatusRow(
            icon: Icons.cloud_outlined,
            label: 'Environment',
            value: config.environmentName,
          ),
          _StatusRow(
            icon: Icons.api_outlined,
            label: 'API base URL',
            value: config.apiBaseUrl,
            monospace: true,
          ),

          const SizedBox(height: 24),
          Card(
            color: colors.surfaceContainerHighest,
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(Icons.info_outline, color: colors.onSurfaceVariant),
                      const SizedBox(width: 8),
                      Text(
                        'What you can still do here',
                        style: textTheme.titleSmall?.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 8),
                  Text(
                    "• Browse the marketplace the same way customers do. "
                    'Useful for spotting layout issues without leaving the '
                    'operator session.',
                    style: textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '• Sign out + sign back in as the right role to test a '
                    'specific user-facing flow.',
                    style: textTheme.bodyMedium,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    '• Confirm the API + Cognito environment your phone is '
                    'pointed at before running a smoke test.',
                    style: textTheme.bodyMedium,
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoleChip extends StatelessWidget {
  const _RoleChip({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        // Use onPrimary-on-primary so the chip reads cleanly on
        // the slate AppBar background (role_theme.dart switches
        // the AppBar to primary for ADMIN).
        color: colors.onPrimary.withValues(alpha: 0.15),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: colors.onPrimary.withValues(alpha: 0.4)),
      ),
      child: Text(
        label,
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: colors.onPrimary,
              letterSpacing: 0.5,
              fontWeight: FontWeight.w600,
            ),
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow({
    required this.icon,
    required this.label,
    required this.value,
    this.monospace = false,
  });

  final IconData icon;
  final String label;
  final String value;
  final bool monospace;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, color: colors.onSurfaceVariant, size: 20),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  label,
                  style: textTheme.labelSmall?.copyWith(
                    color: colors.onSurfaceVariant,
                    letterSpacing: 0.4,
                  ),
                ),
                Text(
                  value,
                  style: monospace
                      ? textTheme.bodyMedium?.copyWith(
                          fontFamily: 'monospace',
                          color: colors.onSurface,
                        )
                      : textTheme.bodyMedium?.copyWith(color: colors.onSurface),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
