// EthioLink Mobile — profile screen.
//
// Phase 9 Track 3 scaffold + Track 2 (Telegram linking row) +
// Track 5 (locale picker). Shows the session's email + role,
// per-env config rows, a Telegram-link entry, a language picker,
// and a Sign-out button.
//
// Phase 9 Track 5 — the locale picker (English / አማርኛ) drives:
//
//   1. `PATCH /v1/me { locale }` through `MeRepository`.
//   2. On success: update the app-level `LocaleScope` so every
//      screen re-renders in the new language, and persist the
//      pick to `LocalePreferences` so the next cold-start uses
//      the same value before the network round-trip completes.
//   3. On failure: roll back the UI selection and show a
//      SnackBar with the `profileLanguageSaveError` copy. The
//      server-side `users.locale` stays canonical.
//
// The picker is intentionally simple — a `RadioListTile` per
// supported locale. A bottom-sheet / dropdown affordance can
// land later if the count grows past 3-4.

// `RadioListTile.groupValue` / `.onChanged` are deprecated under
// Flutter 3.41 in favour of a `RadioGroup` ancestor. Migrating
// the locale picker would expand the widget tree without a UX
// change; the file-level ignore keeps `flutter analyze` clean
// until the API graduates from deprecated to removed.
// ignore_for_file: deprecated_member_use

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_service.dart';
import '../../core/auth/cognito_auth_service.dart';
import '../../core/config/app_config_scope.dart';
import '../../core/i18n/locale_preferences.dart';
import '../../core/i18n/locale_scope.dart';
import '../auth/login_screen.dart';
import 'data/me_repository.dart';
import 'data/telegram_link_repository.dart';
import 'link_telegram_screen.dart';

/// The two-option enumeration shown in the language picker. Kept
/// in lock-step with `AppLocalizations.supportedLocales` — every
/// `SupportedLocale` value has a matching ARB bundle and a
/// matching `users.locale` CHECK constraint on the server.
enum SupportedLocale {
  english(languageCode: 'en', nativeLabel: 'English'),
  amharic(languageCode: 'am', nativeLabel: 'አማርኛ');

  const SupportedLocale({
    required this.languageCode,
    required this.nativeLabel,
  });

  /// ISO 639-1 language code. Matches what the server stores in
  /// `users.locale`.
  final String languageCode;

  /// Display label in the language's own script. The picker
  /// always shows each language's native name so a user who can
  /// only read Amharic can still identify the right row when the
  /// UI is in English.
  final String nativeLabel;

  Locale toLocale() => Locale(languageCode);

  static SupportedLocale fromLanguageCode(String code) {
    for (final entry in SupportedLocale.values) {
      if (entry.languageCode == code) return entry;
    }
    return SupportedLocale.english;
  }
}

class ProfileScreen extends StatefulWidget {
  const ProfileScreen({
    required this.session,
    this.authServiceOverride,
    this.telegramLinkRepositoryOverride,
    this.meRepositoryOverride,
    this.localePreferencesOverride,
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

  /// Phase 9 Track 5 — test seam for the `PATCH /v1/me` call the
  /// locale picker drives. Production constructs an
  /// `HttpMeRepository` from `AppConfigScope`.
  final MeRepository? meRepositoryOverride;

  /// Phase 9 Track 5 — test seam for the locale-cache. Production
  /// uses the same `SecureLocalePreferences` the root
  /// `EthioLinkApp` constructs; widget tests inject an
  /// `InMemoryLocalePreferences` to stay platform-channel-free.
  final LocalePreferences? localePreferencesOverride;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  MeRepository? _meRepo;
  LocalePreferences? _prefs;
  bool _savingLocale = false;

  void _ensureWiring(BuildContext context) {
    _meRepo ??= widget.meRepositoryOverride ??
        HttpMeRepository(ApiClient(config: AppConfigScope.of(context)));
    _prefs ??= widget.localePreferencesOverride ??
        const SecureLocalePreferences();
  }

  Future<void> _onLocalePicked(SupportedLocale pick) async {
    if (_savingLocale) return;
    final controller = LocaleScope.of(context);
    if (controller.locale.languageCode == pick.languageCode) return;

    setState(() => _savingLocale = true);
    final messenger = ScaffoldMessenger.of(context);
    final l10n = AppLocalizations.of(context);
    try {
      await _meRepo!.patchLocale(pick.languageCode);
      // Server accepted — flip the UI + persist locally. Persist
      // is best-effort; even if it fails the next sign-in will
      // re-resolve via `GET /v1/me` once we land that fetch.
      controller.locale = pick.toLocale();
      try {
        await _prefs!.write(pick.toLocale());
      } catch (_) {
        // Storage write errors are non-fatal — log silently. The
        // next launch falls back to the platform default and
        // `users.locale` from the server side stays the truth.
      }
    } on MeUpdateFailure catch (_) {
      // Pre-empt mounted dispose race; bail before touching ctx.
      if (!mounted) return;
      messenger.showSnackBar(
        SnackBar(
          content: Text(l10n.profileLanguageSaveError),
          duration: const Duration(seconds: 3),
        ),
      );
    } finally {
      if (mounted) setState(() => _savingLocale = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final textTheme = Theme.of(context).textTheme;
    final config = AppConfigScope.of(context);
    final l10n = AppLocalizations.of(context);
    _ensureWiring(context);

    final activeLocale = SupportedLocale.fromLanguageCode(
      LocaleScope.of(context).locale.languageCode,
    );

    return Scaffold(
      appBar: AppBar(
        title: Text(l10n.profileTitle),
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
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
            widget.session.email,
            textAlign: TextAlign.center,
            style: textTheme.titleLarge,
          ),
          const SizedBox(height: 4),
          Text(
            l10n.profileRole(widget.session.role),
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
                    repositoryOverride: widget.telegramLinkRepositoryOverride,
                  ),
                ),
              );
            },
          ),
          const SizedBox(height: 24),
          _SectionHeader(text: l10n.profileLanguageHeading),
          for (final entry in SupportedLocale.values)
            RadioListTile<SupportedLocale>(
              key: ValueKey('localeOption.${entry.languageCode}'),
              contentPadding: EdgeInsets.zero,
              value: entry,
              groupValue: activeLocale,
              onChanged: _savingLocale
                  ? null
                  : (picked) {
                      if (picked != null) _onLocalePicked(picked);
                    },
              title: Text(entry.nativeLabel),
              secondary: _savingLocale && entry != activeLocale
                  ? const SizedBox(
                      width: 16,
                      height: 16,
                      child:
                          CircularProgressIndicator(strokeWidth: 2),
                    )
                  : null,
            ),
          if (_savingLocale) ...[
            const SizedBox(height: 4),
            Text(
              l10n.profileLanguageSaving,
              style: textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
            ),
          ],
          const SizedBox(height: 32),
          OutlinedButton.icon(
            onPressed: () async {
              final auth = widget.authServiceOverride ??
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
                    authServiceOverride: widget.authServiceOverride,
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
