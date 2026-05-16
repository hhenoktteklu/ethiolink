// EthioLink Mobile — owner profile / edit-business screen.
//
// Phase 9 Track 3.5 polish (commit "add owner profile editor").
// Closes the last dashboard SnackBar stub. Wraps
// `PATCH /v1/businesses/{id}` so the owner can edit every field
// they entered on the create wizard plus switch category — all
// from a single page.
//
// Behaviour:
//
//   * Form is pre-filled from the loaded `OwnerBusinessView`.
//   * Category dropdown is populated from `CategoriesRepository`
//     (lazy load on mount; loading / error sub-state).
//   * Validators mirror `CreateBusinessFlow`:
//       - name required, max 200
//       - category required
//       - city required, max 100
//       - phone + whatsapp loose regex if present
//   * Save → `PATCH /v1/businesses/{id}` with the populated
//     fields. Cleared optional strings encode as `null` so the
//     server clears the column.
//   * 403 / 409 / network / 5xx renders an inline banner keyed
//     on `BusinessActionFailureKind`.
//   * Success → pop back with the updated `OwnerBusinessView`
//     so the OwnerTab refreshes.
//
// Photo upload + media polish + analytics are deliberately out
// of scope — they pair with the existing `media` flow in a
// future commit.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/data/categories_repository.dart';
import '../browse/models/category.dart';
import 'data/business_actions_repository.dart';
import 'models/owner_business_view.dart';

class OwnerProfileScreen extends StatefulWidget {
  const OwnerProfileScreen({
    required this.business,
    this.actionsRepositoryOverride,
    this.categoriesRepositoryOverride,
    super.key,
  });

  /// The current owner-side view of the business, loaded by the
  /// caller (`OwnerTab`). The form pre-fills from it.
  final OwnerBusinessView business;

  /// Test seam — production constructs an
  /// `HttpBusinessActionsRepository` from the `AppConfigScope`.
  final BusinessActionsRepository? actionsRepositoryOverride;

  /// Test seam — production constructs `HttpCategoriesRepository`.
  final CategoriesRepository? categoriesRepositoryOverride;

  @override
  State<OwnerProfileScreen> createState() => _OwnerProfileScreenState();
}

class _OwnerProfileScreenState extends State<OwnerProfileScreen> {
  BusinessActionsRepository? _actionsRepo;
  CategoriesRepository? _categoriesRepo;

  Future<List<Category>>? _categoriesFuture;

  // Form keys + controllers — owned by the State so values persist
  // across rebuilds (e.g. when the category dropdown's snapshot
  // arrives mid-edit).
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _nameCtrl;
  String? _categoryId;
  late final TextEditingController _cityCtrl;
  late final TextEditingController _addressCtrl;
  late final TextEditingController _phoneCtrl;
  late final TextEditingController _telegramCtrl;
  late final TextEditingController _whatsappCtrl;
  late final TextEditingController _descriptionCtrl;

  bool _busy = false;
  BusinessActionFailure? _error;
  String? _saveMessage;

  // Loose phone regex from CreateBusinessFlow. `+`-or-digit prefix,
  // 6–20 chars of digits/spaces/hyphens.
  static const _phoneAllowed = r'^[+0-9][0-9 \-]{5,19}$';

  @override
  void initState() {
    super.initState();
    final b = widget.business;
    _nameCtrl = TextEditingController(text: b.name ?? '');
    _categoryId = b.detail.categoryId;
    _cityCtrl = TextEditingController(text: b.city ?? '');
    _addressCtrl = TextEditingController(text: b.detail.addressLine ?? '');
    _phoneCtrl = TextEditingController(text: b.detail.phone ?? '');
    _telegramCtrl =
        TextEditingController(text: b.detail.telegramHandle ?? '');
    _whatsappCtrl =
        TextEditingController(text: b.detail.whatsappPhone ?? '');
    _descriptionCtrl =
        TextEditingController(text: b.descriptionEn ?? '');
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_actionsRepo != null) return;
    _actionsRepo = widget.actionsRepositoryOverride ??
        HttpBusinessActionsRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _categoriesRepo = widget.categoriesRepositoryOverride ??
        HttpCategoriesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _categoriesFuture = _categoriesRepo!.list();
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _cityCtrl.dispose();
    _addressCtrl.dispose();
    _phoneCtrl.dispose();
    _telegramCtrl.dispose();
    _whatsappCtrl.dispose();
    _descriptionCtrl.dispose();
    super.dispose();
  }

  // --- Validators -----------------------------------------------------------

  String? _validateRequired(String? v, String label) {
    if (v == null || v.trim().isEmpty) return '$label is required.';
    return null;
  }

  String? _validatePhone(String? v) {
    if (v == null || v.trim().isEmpty) return null; // optional
    final ok = RegExp(_phoneAllowed).hasMatch(v.trim());
    if (!ok) {
      return 'Use digits + spaces / hyphens, optionally starting with +.';
    }
    return null;
  }

  // --- Save ----------------------------------------------------------------

  Future<void> _save() async {
    final ok = _formKey.currentState?.validate() ?? false;
    if (!ok) return;
    if (_categoryId == null) {
      setState(() => _error = BusinessActionFailure(
            kind: BusinessActionFailureKind.validation,
            message: 'Pick a category before saving.',
          ));
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
      _saveMessage = null;
    });

    String? optionalOrNull(String raw) {
      final v = raw.trim();
      return v.isEmpty ? null : v;
    }

    final desc = _descriptionCtrl.text.trim();
    final addr = _addressCtrl.text.trim();
    final phone = _phoneCtrl.text.trim();
    final telegram = _telegramCtrl.text.trim();
    final whatsapp = _whatsappCtrl.text.trim();

    final req = PatchBusinessRequest(
      categoryId: _categoryId,
      name: _nameCtrl.text.trim(),
      city: _cityCtrl.text.trim(),
      descriptionEn: optionalOrNull(desc),
      clearDescription: desc.isEmpty,
      addressLine: optionalOrNull(addr),
      clearAddress: addr.isEmpty,
      phone: optionalOrNull(phone),
      clearPhone: phone.isEmpty,
      telegramHandle: optionalOrNull(telegram),
      clearTelegram: telegram.isEmpty,
      whatsappPhone: optionalOrNull(whatsapp),
      clearWhatsapp: whatsapp.isEmpty,
    );

    try {
      final updated =
          await _actionsRepo!.updateBusiness(widget.business.id, req);
      if (!mounted) return;
      setState(() => _saveMessage = 'Profile saved.');
      // Pop back so OwnerTab refreshes with the latest view.
      // Slight delay so the operator sees the success snack.
      await Future<void>.delayed(const Duration(milliseconds: 250));
      if (!mounted) return;
      Navigator.of(context).pop<OwnerBusinessView>(updated);
    } on BusinessActionFailure catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  // --- Build ---------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Business profile')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
            children: [
              if (_error != null) _ErrorBanner(error: _error!),
              if (_saveMessage != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    _saveMessage!,
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ),
                ),
              TextFormField(
                controller: _nameCtrl,
                decoration: const InputDecoration(
                  labelText: 'Business name',
                  border: OutlineInputBorder(),
                ),
                maxLength: 200,
                validator: (v) => _validateRequired(v, 'Business name'),
              ),
              const SizedBox(height: 12),
              _categoryField(),
              const SizedBox(height: 12),
              TextFormField(
                controller: _cityCtrl,
                decoration: const InputDecoration(
                  labelText: 'City',
                  border: OutlineInputBorder(),
                ),
                maxLength: 100,
                validator: (v) => _validateRequired(v, 'City'),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _addressCtrl,
                decoration: const InputDecoration(
                  labelText: 'Address',
                  hintText: 'Optional. Street + landmark.',
                  border: OutlineInputBorder(),
                ),
                maxLines: 2,
                maxLength: 500,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _phoneCtrl,
                decoration: const InputDecoration(
                  labelText: 'Phone',
                  hintText: 'Optional. e.g. +251 911 000000',
                  border: OutlineInputBorder(),
                ),
                maxLength: 50,
                keyboardType: TextInputType.phone,
                validator: _validatePhone,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _telegramCtrl,
                decoration: const InputDecoration(
                  labelText: 'Telegram handle',
                  hintText: 'Optional. e.g. @yourbusiness',
                  border: OutlineInputBorder(),
                ),
                maxLength: 50,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _whatsappCtrl,
                decoration: const InputDecoration(
                  labelText: 'WhatsApp number',
                  hintText: 'Optional. e.g. +251 911 000000',
                  border: OutlineInputBorder(),
                ),
                maxLength: 50,
                keyboardType: TextInputType.phone,
                validator: _validatePhone,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _descriptionCtrl,
                decoration: const InputDecoration(
                  labelText: 'Description (English)',
                  hintText:
                      'Optional. Share what you offer and what makes '
                      'you stand out.',
                  border: OutlineInputBorder(),
                  alignLabelWithHint: true,
                ),
                maxLines: 5,
                minLines: 3,
                maxLength: 2000,
              ),
              const SizedBox(height: 16),
              Row(
                children: [
                  OutlinedButton(
                    onPressed: _busy
                        ? null
                        : () => Navigator.of(context).pop<OwnerBusinessView?>(),
                    child: const Text('Cancel'),
                  ),
                  const Spacer(),
                  FilledButton.icon(
                    onPressed: _busy ? null : _save,
                    icon: _busy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.save),
                    label: const Text('Save changes'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _categoryField() {
    return FutureBuilder<List<Category>>(
      future: _categoriesFuture,
      builder: (context, snap) {
        if (snap.connectionState == ConnectionState.waiting) {
          return const Padding(
            padding: EdgeInsets.symmetric(vertical: 16),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        if (snap.hasError) {
          return Text(
            'Could not load categories: ${snap.error}',
            style: TextStyle(color: Theme.of(context).colorScheme.error),
          );
        }
        final items = snap.data ?? <Category>[];
        return DropdownButtonFormField<String>(
          initialValue: _categoryId,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: 'Category',
            border: OutlineInputBorder(),
          ),
          items: [
            for (final c in items)
              DropdownMenuItem(value: c.id, child: Text(c.nameEn)),
          ],
          onChanged: (v) => setState(() => _categoryId = v),
        );
      },
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.error});
  final BusinessActionFailure error;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (title, body) = _copyFor(error);
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: Theme.of(context).textTheme.titleSmall?.copyWith(
                  color: colors.onErrorContainer,
                ),
          ),
          const SizedBox(height: 4),
          Text(
            body,
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: colors.onErrorContainer,
                ),
          ),
        ],
      ),
    );
  }

  (String, String) _copyFor(BusinessActionFailure e) {
    switch (e.kind) {
      case BusinessActionFailureKind.validation:
        return ('Check your details', e.message);
      case BusinessActionFailureKind.forbidden:
        return (
          'Access denied',
          'Your role may have changed. Sign out and back in, then try again.',
        );
      case BusinessActionFailureKind.unauthenticated:
        return ('Sign in required', 'Your session expired. Sign in again.');
      case BusinessActionFailureKind.conflict:
        return (
          'Conflicting state',
          'The business is in a state that blocks this change.',
        );
      case BusinessActionFailureKind.notFound:
        return ('Not found', 'This business no longer exists.');
      case BusinessActionFailureKind.network:
        return ("Can't reach the server", 'Check your connection and retry.');
      case BusinessActionFailureKind.serverError:
        return ('Something went wrong', 'Please try again in a moment.');
      case BusinessActionFailureKind.malformedResponse:
      case BusinessActionFailureKind.other:
        return ('Something went wrong', e.message);
    }
  }
}
