// EthioLink Mobile — placeholder profile screen.
//
// Phase 9 Track 3 scaffold. The real screen will surface
// `GET /v1/me` + a "Sign out" button that hits Cognito's hosted
// `/logout` endpoint. The placeholder shows the (fake) session's
// email + role and a sign-out button that just pops back to the
// login screen.

import 'package:flutter/material.dart';
import 'package:flutter_gen/gen_l10n/app_localizations.dart';

import '../../core/auth/auth_service.dart';
import '../../core/auth/cognito_auth_service.dart';
import '../../core/config/app_config_scope.dart';
import '../auth/login_screen.dart';
import 'data/telegram_link_repository.dart';
import 'link_telegram_screen.dart';

class ProfileScreen extends StatelessWidget {
  const ProfileScreen({
    required this.session,
    this.authServiceOverride,
    this.telegramLinkRepositoryOverride,
    super.key,
  });

  final AuthSession session;

  /// Phase 9 — `BrowseScreen` forwards the same `authServiceOverride`
  /// down so tests can short-circuit the real Cognito service. The
  /// sign-out button below uses this when present.
  final AuthService? authServiceOverride;

  /// Phase 9 Track 2 — test seam forwarded to `LinkTelegramScreen`
  /// when the user taps the Notifications row. Production leaves
  /// this `null` and the screen constructs its own
  /// `HttpTelegramLinkRepository` over the `AppConfigScope`.
  final TelegramLinkRepository? telegramLinkRepositoryOverride;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final config = AppConfigScope.of(context);
    final l10n = AppLocalizations.of(context);

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.profileTitle),
      ),
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const SizedBox(height: 16),
            CircleAvatar(
              radius: 48,
              backgroundColor: colors.primaryContainer,
              child: Icon(
                Icons.person,
                size: 48,
                color: colors.onPrimaryContainer,
              ),
            ),
            const SizedBox(height: 16),
            Text(
              session.email,
              textAlign: TextAlign.center,
              style: textTheme.titleLarge,
            ),
            const SizedBox(height: 4),
            Text(
              l10n.profileRole(session.role),
              textAlign: TextAlign.center,
              style: textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
            const SizedBox(height: 32),
            _ConfigRow(label: 'Environment', value: config.environmentName),
            _ConfigRow(label: 'API base', value: config.apiBaseUrl),
            _ConfigRow(label: 'Cognito domain', value: config.cognitoDomain),
            const SizedBox(height: 24),
            _SectionHeader(text: l10n.profileNotificationsHeading),
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: Icon(Icons.telegram, color: colors.primary),
              title: Text(l10n.profileTelegramTitle),
              subtitle: Text(l10n.profileTelegramSubtitle),
              trailing: const Icon(Icons.chevron_right),
              onTap: () {
                Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => LinkTelegramScreen(
                      repositoryOverride: telegramLinkRepositoryOverride,
                    ),
                  ),
                );
              },
            ),
            const Spacer(),
            OutlinedButton.icon(
              onPressed: () async {
                final auth = authServiceOverride ??
                    CognitoAuthService(config: config);
                try {
                  await auth.signOut();
                } catch (_) {
                  // Sign-out is best-effort — the cache is cleared
                  // even if the hosted-UI logout call fails. The
                  // user still lands on the LoginScreen below.
                }
                if (!context.mounted) return;
                Navigator.of(context).pushAndRemoveUntil(
                  MaterialPageRoute<void>(
                    builder: (_) => LoginScreen(
                      authServiceOverride: authServiceOverride,
                    ),
                  ),
                  (_) => false,
                );
              },
              icon: const Icon(Icons.logout),
              label: Text(l10n.profileSignOut),
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Text(
        text,
        style: Theme.of(context).textTheme.titleSmall?.copyWith(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
      ),
    );
  }
}

class _ConfigRow extends StatelessWidget {
  const _ConfigRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 120,
            child: Text(
              label,
              style: textTheme.labelMedium?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
          Expanded(
            child: Text(
              value,
              style: textTheme.bodySmall,
            ),
          ),
        ],
      ),
    );
  }
}
