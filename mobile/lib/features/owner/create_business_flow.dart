// EthioLink Mobile — owner create-business multi-step form.
//
// Phase 9 Track 3.5 second commit. Replaces the previous
// SnackBar placeholder on the `_CreateBusinessCta` 404 branch.
//
// The flow is a four-step wizard backed by a single `Form` per
// step + a shared draft object held on State. Steps:
//
//   * 0 — Basics: name + category + city. All required for the
//     owner to advance.
//   * 1 — Contact: address, phone, telegram handle, whatsapp
//     phone. All optional; phone is validated loosely if present
//     (`+` or digit prefix, 6–20 chars of digits/spaces/hyphens).
//   * 2 — Description: English description (`LocalizedText.en`).
//     Optional at create time; the API surfaces a 400 with
//     `details.missing` when the owner later tries to submit
//     without one.
//   * 3 — Review: a read-only summary of the draft + Create
//     button. Tapping Create issues `POST /v1/businesses` and
//     transitions to step 4 on success.
//   * 4 — Success: shows DRAFT confirmation + two buttons:
//       - "Submit for review" → `POST /v1/businesses/{id}/submit`,
//         transitions to step 5 on success.
//       - "Back to dashboard" → `Navigator.pop(view)`. OwnerTab
//         refreshes on pop using the returned `OwnerBusinessView`.
//   * 5 — Submitted: PENDING_REVIEW confirmation + "Back to
//     dashboard". Same pop semantics.
//
// Failure handling is per-step. Validation errors render under
// the offending field; transport / API failures render a top-of-
// screen banner (the `_ErrorBanner`) classified by
// `BusinessActionFailureKind`. The banner is dismissed on next
// action.
//
// State management is intentionally vanilla `setState` — every
// step holds local `TextEditingController`s; the parent state
// owns the in-flight `OwnerBusinessView?` (null until create
// succeeds), the loading flag, and the optional error.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/data/categories_repository.dart';
import '../browse/models/category.dart';
import 'data/business_actions_repository.dart';
import 'models/owner_business_view.dart';

class CreateBusinessFlow extends StatefulWidget {
  const CreateBusinessFlow({
    this.categoriesRepositoryOverride,
    this.actionsRepositoryOverride,
    super.key,
  });

  /// Test seam — production constructs `HttpCategoriesRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final CategoriesRepository? categoriesRepositoryOverride;

  /// Test seam — production constructs `HttpBusinessActionsRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final BusinessActionsRepository? actionsRepositoryOverride;

  @override
  State<CreateBusinessFlow> createState() => _CreateBusinessFlowState();
}

class _CreateBusinessFlowState extends State<CreateBusinessFlow> {
  // Step machinery
  int _step = 0;

  // Repositories (constructed lazily on first didChangeDependencies)
  CategoriesRepository? _categoriesRepo;
  BusinessActionsRepository? _actionsRepo;

  // Categories list — loaded once on entry to populate the dropdown.
  Future<List<Category>>? _categoriesFuture;

  // Form controllers — owned by the parent state so values
  // persist across step transitions.
  final _nameCtrl = TextEditingController();
  String? _categoryId;
  final _cityCtrl = TextEditingController();
  final _addressCtrl = TextEditingController();
  final _phoneCtrl = TextEditingController();
  final _telegramCtrl = TextEditingController();
  final _whatsappCtrl = TextEditingController();
  final _descriptionCtrl = TextEditingController();

  // Form keys — one per step that needs validation.
  final _basicsKey = GlobalKey<FormState>();
  final _contactKey = GlobalKey<FormState>();

  // Lifecycle of the create / submit calls.
  bool _busy = false;
  BusinessActionFailure? _error;

  /// Populated once `createBusiness` succeeds. The success step
  /// branches on `view.status`: DRAFT → "Submit for review" CTA;
  /// PENDING_REVIEW (after submit) → "Awaiting review" copy.
  OwnerBusinessView? _view;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_categoriesRepo != null) return;
    _categoriesRepo = widget.categoriesRepositoryOverride ??
        HttpCategoriesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _actionsRepo = widget.actionsRepositoryOverride ??
        HttpBusinessActionsRepository(
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

  // -------------------------------------------------------------------------
  // Validation helpers
  // -------------------------------------------------------------------------

  static const _phoneAllowed = r'^[+0-9][0-9 \-]{5,19}$';

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

  // -------------------------------------------------------------------------
  // Step transitions
  // -------------------------------------------------------------------------

  void _goNext() {
    setState(() => _error = null);
    if (_step == 0) {
      final ok = _basicsKey.currentState?.validate() ?? false;
      if (!ok) return;
      if (_categoryId == null) {
        // Surface a top banner since the dropdown isn't a TextFormField.
        setState(() => _error = BusinessActionFailure(
              kind: BusinessActionFailureKind.validation,
              message: 'Pick a category before continuing.',
            ));
        return;
      }
    }
    if (_step == 1) {
      final ok = _contactKey.currentState?.validate() ?? false;
      if (!ok) return;
    }
    setState(() => _step += 1);
  }

  void _goBack() {
    setState(() {
      _error = null;
      if (_step > 0) _step -= 1;
    });
  }

  // -------------------------------------------------------------------------
  // Network actions
  // -------------------------------------------------------------------------

  Future<void> _submitCreate() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final view = await _actionsRepo!.createBusiness(
        CreateBusinessRequest(
          categoryId: _categoryId!,
          name: _nameCtrl.text.trim(),
          descriptionEn: _descriptionCtrl.text.trim(),
          city: _cityCtrl.text.trim(),
          addressLine: _addressCtrl.text.trim(),
          phone: _phoneCtrl.text.trim(),
          telegramHandle: _telegramCtrl.text.trim(),
          whatsappPhone: _whatsappCtrl.text.trim(),
        ),
      );
      if (!mounted) return;
      setState(() {
        _view = view;
        _step = 4;
      });
    } on BusinessActionFailure catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _submitForReview() async {
    final view = _view;
    if (view == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final next = await _actionsRepo!.submitBusiness(view.id);
      if (!mounted) return;
      setState(() {
        _view = next;
        _step = 5;
      });
    } on BusinessActionFailure catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _popWithView() {
    Navigator.of(context).pop<OwnerBusinessView?>(_view);
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Create your business'),
        leading: BackButton(
          onPressed: () {
            if (_step > 0 && _step < 4) {
              _goBack();
            } else {
              _popWithView();
            }
          },
        ),
      ),
      body: SafeArea(
        child: Column(
          children: [
            _StepIndicator(stepCount: 4, current: _step.clamp(0, 3)),
            if (_error != null)
              _ErrorBanner(
                error: _error!,
                onDismiss: () => setState(() => _error = null),
              ),
            Expanded(
              child: AbsorbPointer(
                absorbing: _busy,
                child: _stepBody(),
              ),
            ),
            _footerForStep(),
          ],
        ),
      ),
    );
  }

  Widget _stepBody() {
    switch (_step) {
      case 0:
        return _basicsStep();
      case 1:
        return _contactStep();
      case 2:
        return _descriptionStep();
      case 3:
        return _reviewStep();
      case 4:
        return _draftSuccessStep();
      case 5:
        return _submittedSuccessStep();
      default:
        return const SizedBox.shrink();
    }
  }

  // ---------------- Basics step ----------------

  Widget _basicsStep() {
    return Form(
      key: _basicsKey,
      autovalidateMode: AutovalidateMode.disabled,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
        children: [
          Text(
            'Tell us about your business',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _nameCtrl,
            decoration: const InputDecoration(
              labelText: 'Business name',
              hintText: 'e.g. Sunset Salon',
              border: OutlineInputBorder(),
            ),
            maxLength: 200,
            validator: (v) => _validateRequired(v, 'Business name'),
          ),
          const SizedBox(height: 12),
          FutureBuilder<List<Category>>(
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
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                  ),
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
                    DropdownMenuItem(
                      value: c.id,
                      child: Text(c.nameEn),
                    ),
                ],
                onChanged: (v) => setState(() => _categoryId = v),
              );
            },
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _cityCtrl,
            decoration: const InputDecoration(
              labelText: 'City',
              hintText: 'e.g. Addis Ababa',
              border: OutlineInputBorder(),
            ),
            maxLength: 100,
            validator: (v) => _validateRequired(v, 'City'),
          ),
        ],
      ),
    );
  }

  // ---------------- Contact step ----------------

  Widget _contactStep() {
    return Form(
      key: _contactKey,
      autovalidateMode: AutovalidateMode.disabled,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
        children: [
          Text(
            'How can customers reach you?',
            style: Theme.of(context).textTheme.titleMedium,
          ),
          const SizedBox(height: 4),
          Text(
            'All fields optional — you can fill them in later from the '
            'business profile.',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _addressCtrl,
            decoration: const InputDecoration(
              labelText: 'Address',
              hintText: 'Street, neighborhood, landmark',
              border: OutlineInputBorder(),
            ),
            maxLength: 500,
            maxLines: 2,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _phoneCtrl,
            decoration: const InputDecoration(
              labelText: 'Phone',
              hintText: '+251 911 000000',
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
              hintText: '@yourbusiness',
              border: OutlineInputBorder(),
            ),
            maxLength: 50,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _whatsappCtrl,
            decoration: const InputDecoration(
              labelText: 'WhatsApp number',
              hintText: '+251 911 000000',
              border: OutlineInputBorder(),
            ),
            maxLength: 50,
            keyboardType: TextInputType.phone,
            validator: _validatePhone,
          ),
        ],
      ),
    );
  }

  // ---------------- Description step ----------------

  Widget _descriptionStep() {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
      children: [
        Text(
          'Describe your business',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Optional now — required before you submit for review.',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _descriptionCtrl,
          decoration: const InputDecoration(
            labelText: 'Description (English)',
            hintText:
                'Share what you offer, what makes you stand out, '
                'who you serve.',
            border: OutlineInputBorder(),
            alignLabelWithHint: true,
          ),
          maxLines: 6,
          minLines: 4,
          maxLength: 2000,
        ),
      ],
    );
  }

  // ---------------- Review step ----------------

  Widget _reviewStep() {
    // Look up the chosen category name for the summary card.
    String? categoryName;
    final repo = _categoriesRepo;
    if (repo != null && _categoryId != null) {
      // The categoriesFuture is already complete by step 3; we
      // peek at the FutureBuilder's snapshot by re-reading it.
      // For simplicity we re-fetch — but rather than hit network,
      // we resolve the name from the existing future.
    }
    return FutureBuilder<List<Category>>(
      future: _categoriesFuture,
      builder: (context, snap) {
        if (snap.hasData && _categoryId != null) {
          for (final c in snap.data!) {
            if (c.id == _categoryId) {
              categoryName = c.nameEn;
              break;
            }
          }
        }
        return ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
          children: [
            Text(
              'Review your details',
              style: Theme.of(context).textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              'Saved as DRAFT — you can edit before submitting for review.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                  ),
            ),
            const SizedBox(height: 12),
            _ReviewCard(
              entries: [
                ('Business name', _nameCtrl.text.trim()),
                ('Category', categoryName ?? '—'),
                ('City', _cityCtrl.text.trim()),
                if (_addressCtrl.text.trim().isNotEmpty)
                  ('Address', _addressCtrl.text.trim()),
                if (_phoneCtrl.text.trim().isNotEmpty)
                  ('Phone', _phoneCtrl.text.trim()),
                if (_telegramCtrl.text.trim().isNotEmpty)
                  ('Telegram', _telegramCtrl.text.trim()),
                if (_whatsappCtrl.text.trim().isNotEmpty)
                  ('WhatsApp', _whatsappCtrl.text.trim()),
                if (_descriptionCtrl.text.trim().isNotEmpty)
                  ('Description', _descriptionCtrl.text.trim()),
              ],
            ),
          ],
        );
      },
    );
  }

  // ---------------- Success steps ----------------

  Widget _draftSuccessStep() {
    final view = _view!;
    final colors = Theme.of(context).colorScheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
      children: [
        Icon(Icons.check_circle, color: colors.primary, size: 64),
        const SizedBox(height: 12),
        Text(
          'Draft saved',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 4),
        Text(
          '${view.name ?? "Your business"} is in DRAFT. Submit it '
          'for admin review when you are ready — or come back later '
          'from the My Business tab.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 24),
      ],
    );
  }

  Widget _submittedSuccessStep() {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 32, 24, 32),
      children: [
        Icon(Icons.hourglass_top, color: colors.primary, size: 64),
        const SizedBox(height: 12),
        Text(
          'Awaiting review',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleLarge,
        ),
        const SizedBox(height: 4),
        Text(
          'An admin will review your business and notify you when '
          'the decision lands. You can keep editing services, staff, '
          'and availability while you wait.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
      ],
    );
  }

  // ---------------- Footer ----------------

  Widget _footerForStep() {
    if (_busy) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    switch (_step) {
      case 0:
      case 1:
      case 2:
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              if (_step > 0)
                OutlinedButton(
                  onPressed: _goBack,
                  child: const Text('Back'),
                ),
              const Spacer(),
              FilledButton(
                onPressed: _goNext,
                child: const Text('Next'),
              ),
            ],
          ),
        );
      case 3:
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              OutlinedButton(
                onPressed: _goBack,
                child: const Text('Back'),
              ),
              const Spacer(),
              FilledButton.icon(
                onPressed: _submitCreate,
                icon: const Icon(Icons.check),
                label: const Text('Create'),
              ),
            ],
          ),
        );
      case 4:
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              OutlinedButton(
                onPressed: _popWithView,
                child: const Text('Back to dashboard'),
              ),
              const Spacer(),
              FilledButton.icon(
                onPressed: _submitForReview,
                icon: const Icon(Icons.send),
                label: const Text('Submit for review'),
              ),
            ],
          ),
        );
      case 5:
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const Spacer(),
              FilledButton(
                onPressed: _popWithView,
                child: const Text('Back to dashboard'),
              ),
            ],
          ),
        );
      default:
        return const SizedBox.shrink();
    }
  }
}

// ---------------------------------------------------------------------------
// Helper widgets
// ---------------------------------------------------------------------------

class _StepIndicator extends StatelessWidget {
  const _StepIndicator({required this.stepCount, required this.current});
  final int stepCount;
  final int current;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Row(
        children: [
          for (var i = 0; i < stepCount; i++) ...[
            Expanded(
              child: Container(
                height: 4,
                decoration: BoxDecoration(
                  color: i <= current
                      ? colors.primary
                      : colors.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            if (i < stepCount - 1) const SizedBox(width: 4),
          ],
        ],
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.error, required this.onDismiss});
  final BusinessActionFailure error;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final (title, body) = _copyFor(error);
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Icon(Icons.error_outline, color: colors.onErrorContainer),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: Theme.of(context).textTheme.titleSmall?.copyWith(
                        color: colors.onErrorContainer,
                      ),
                ),
                Text(
                  body,
                  style: Theme.of(context).textTheme.bodySmall?.copyWith(
                        color: colors.onErrorContainer,
                      ),
                ),
              ],
            ),
          ),
          IconButton(
            icon: const Icon(Icons.close),
            color: colors.onErrorContainer,
            onPressed: onDismiss,
          ),
        ],
      ),
    );
  }

  /// Copy lookup keyed off `BusinessActionFailureKind`. Returns a
  /// `(title, body)` record so the surrounding banner stays simple.
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
        return (
          'Sign in required',
          'Your session expired. Sign in again to continue.',
        );
      case BusinessActionFailureKind.conflict:
        return (
          'You already have a business',
          'Refresh the My Business tab to see your existing record.',
        );
      case BusinessActionFailureKind.notFound:
        return ('Not found', e.message);
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

class _ReviewCard extends StatelessWidget {
  const _ReviewCard({required this.entries});
  final List<(String, String)> entries;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final (label, value) in entries) ...[
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                    ),
                    Text(
                      value,
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
