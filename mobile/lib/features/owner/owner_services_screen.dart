// EthioLink Mobile — owner services CRUD screen.
//
// Phase 9 Track 3.5 third commit. Replaces the dashboard
// Services card's SnackBar placeholder with a real screen
// implementing the four owner-side operations:
//
//   * List the business's services. The public listing endpoint
//     returns only active services (the API filter is
//     `is_active = TRUE`), so the screen renders one tab. Every
//     row shows the active/inactive badge defensively — the
//     server can flip a service to inactive between fetches and
//     we re-render whatever the server returns.
//   * Create a service via the `_ServiceFormSheet` modal.
//   * Edit a service via the same `_ServiceFormSheet`, pre-
//     populated from the row.
//   * Soft-delete (deactivate) a service via a confirmation
//     dialog; the row disappears from the next refresh because
//     the list endpoint filters inactive rows.
//
// The screen is wired into `OwnerDashboard` — tapping the
// Services card pushes this widget. The business id is read off
// the loaded `OwnerBusinessView` so we never hit the network for
// it independently.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/models/service.dart';
import 'data/owner_services_repository.dart';

class OwnerServicesScreen extends StatefulWidget {
  const OwnerServicesScreen({
    required this.businessId,
    this.repositoryOverride,
    super.key,
  });

  /// The business whose services we list. Read from the loaded
  /// `OwnerBusinessView` at the call site.
  final String businessId;

  /// Test seam — production constructs `HttpOwnerServicesRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final OwnerServicesRepository? repositoryOverride;

  @override
  State<OwnerServicesScreen> createState() => _OwnerServicesScreenState();
}

class _OwnerServicesScreenState extends State<OwnerServicesScreen> {
  OwnerServicesRepository? _repo;
  Future<List<Service>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpOwnerServicesRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      _future = _repo!.listServices(widget.businessId);
    });
  }

  // -------------------------------------------------------------------------
  // Sheet driver — `null` editing → create; non-null → edit.
  // -------------------------------------------------------------------------

  Future<void> _openForm({Service? editing}) async {
    final result = await showModalBottomSheet<Service?>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        return Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(sheetContext).viewInsets.bottom,
          ),
          child: _ServiceFormSheet(
            existing: editing,
            onSubmit: (CreateServiceRequest? create,
                UpdateServiceRequest? patch) async {
              if (editing == null) {
                return _repo!.createService(widget.businessId, create!);
              }
              return _repo!.updateService(
                widget.businessId,
                editing.id,
                patch!,
              );
            },
          ),
        );
      },
    );
    if (result != null && mounted) _refresh();
  }

  Future<void> _confirmDeactivate(Service service) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('Deactivate service?'),
          content: Text(
            'Customers will no longer see "${service.nameEn}" in the '
            'booking flow. You can recreate it later if needed.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('Cancel'),
            ),
            FilledButton.tonal(
              style: FilledButton.styleFrom(
                foregroundColor: Theme.of(ctx).colorScheme.error,
              ),
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('Deactivate'),
            ),
          ],
        );
      },
    );
    if (ok != true || !mounted) return;
    try {
      await _repo!.deactivateService(widget.businessId, service.id);
      if (!mounted) return;
      _refresh();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('"${service.nameEn}" deactivated.'),
          duration: const Duration(seconds: 2),
        ),
      );
    } on OwnerServicesFailure catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(_topErrorCopy(e))),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Services')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openForm(),
        icon: const Icon(Icons.add),
        label: const Text('Add service'),
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          _refresh();
          try {
            await _future;
          } catch (_) {/* surfaced in FutureBuilder */}
        },
        child: FutureBuilder<List<Service>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState == ConnectionState.waiting) {
              return const _Loading();
            }
            if (snap.hasError) {
              return _ErrorBranch(error: snap.error!, onRetry: _refresh);
            }
            final services = snap.data ?? <Service>[];
            if (services.isEmpty) return const _EmptyState();
            return ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
              itemCount: services.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, i) {
                final svc = services[i];
                return _ServiceRow(
                  service: svc,
                  onEdit: () => _openForm(editing: svc),
                  onDeactivate: svc.isActive
                      ? () => _confirmDeactivate(svc)
                      : null,
                );
              },
            );
          },
        ),
      ),
    );
  }

  /// Maps a transport / API failure to single-line SnackBar copy
  /// for the deactivate path. The richer per-step error banner
  /// (the create-business-flow style) is overkill for a one-shot
  /// destructive action — a SnackBar suffices.
  String _topErrorCopy(OwnerServicesFailure e) {
    switch (e.kind) {
      case OwnerServicesFailureKind.network:
        return "Can't reach the server. Try again in a moment.";
      case OwnerServicesFailureKind.forbidden:
        return 'Access denied — sign out and back in to refresh your role.';
      case OwnerServicesFailureKind.unauthenticated:
        return 'Sign in again to continue.';
      case OwnerServicesFailureKind.notFound:
        return 'This service no longer exists. Pull to refresh.';
      case OwnerServicesFailureKind.conflict:
        return 'The service is in a conflicting state.';
      case OwnerServicesFailureKind.validation:
        return e.message;
      case OwnerServicesFailureKind.serverError:
      case OwnerServicesFailureKind.malformedResponse:
      case OwnerServicesFailureKind.other:
        return 'Something went wrong. ${e.message}';
    }
  }
}

// ---------------------------------------------------------------------------
// Sub-widgets
// ---------------------------------------------------------------------------

class _Loading extends StatelessWidget {
  const _Loading();
  @override
  Widget build(BuildContext context) {
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      children: const [
        SizedBox(height: 96),
        Center(child: CircularProgressIndicator()),
      ],
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.design_services_outlined, size: 72, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'No services yet',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Add the services customers can book — haircuts, manicures, '
          'massages, anything you charge for. Tap "Add service" to start.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
      ],
    );
  }
}

class _ErrorBranch extends StatelessWidget {
  const _ErrorBranch({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isNetwork = error is OwnerServicesFailure &&
        (error as OwnerServicesFailure).kind ==
            OwnerServicesFailureKind.network;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(
          isNetwork ? Icons.wifi_off : Icons.error_outline,
          size: 56,
          color: colors.error,
        ),
        const SizedBox(height: 12),
        Text(
          isNetwork
              ? "Can't reach the server"
              : 'Could not load services',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          error.toString(),
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 16),
        Center(
          child: FilledButton.icon(
            onPressed: onRetry,
            icon: const Icon(Icons.refresh),
            label: const Text('Try again'),
          ),
        ),
      ],
    );
  }
}

class _ServiceRow extends StatelessWidget {
  const _ServiceRow({
    required this.service,
    required this.onEdit,
    required this.onDeactivate,
  });

  final Service service;
  final VoidCallback onEdit;

  /// `null` → row is already inactive; the deactivate action is
  /// hidden. Active rows pass a tap handler that confirms then
  /// fires `DELETE`.
  final VoidCallback? onDeactivate;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final priceLabel = service.priceEtb != null
        ? '${service.priceEtb!.toStringAsFixed(0)} ETB'
        : 'No price set';
    final durationLabel = '${service.durationMinutes} min';
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onEdit,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            service.nameEn,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        _StatusChip(active: service.isActive),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      '$durationLabel · $priceLabel',
                      style: Theme.of(context).textTheme.bodySmall?.copyWith(
                            color: colors.onSurfaceVariant,
                          ),
                    ),
                    if (service.descriptionEn != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        service.descriptionEn!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ],
                  ],
                ),
              ),
              if (onDeactivate != null)
                IconButton(
                  tooltip: 'Deactivate',
                  icon: const Icon(Icons.delete_outline),
                  onPressed: onDeactivate,
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _StatusChip extends StatelessWidget {
  const _StatusChip({required this.active});
  final bool active;
  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final bg = active ? colors.primaryContainer : colors.surfaceContainerHigh;
    final fg = active ? colors.onPrimaryContainer : colors.onSurfaceVariant;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        active ? 'ACTIVE' : 'INACTIVE',
        style: Theme.of(context).textTheme.labelSmall?.copyWith(
              color: fg,
              letterSpacing: 0.5,
            ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Service form modal — used for both create + edit
// ---------------------------------------------------------------------------

/// Bottom-sheet form. The `onSubmit` callback receives either a
/// `CreateServiceRequest` (when `existing == null`) or an
/// `UpdateServiceRequest` (when `existing != null`). The widget
/// drives the in-flight + error state itself so the parent
/// `OwnerServicesScreen` doesn't have to.
class _ServiceFormSheet extends StatefulWidget {
  const _ServiceFormSheet({
    required this.existing,
    required this.onSubmit,
  });

  final Service? existing;
  final Future<Service> Function(
    CreateServiceRequest? create,
    UpdateServiceRequest? patch,
  ) onSubmit;

  @override
  State<_ServiceFormSheet> createState() => _ServiceFormSheetState();
}

class _ServiceFormSheetState extends State<_ServiceFormSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _nameCtrl;
  late final TextEditingController _durationCtrl;
  late final TextEditingController _priceCtrl;
  late final TextEditingController _descriptionCtrl;

  bool _busy = false;
  OwnerServicesFailure? _error;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _nameCtrl = TextEditingController(text: e?.nameEn ?? '');
    _durationCtrl = TextEditingController(
      text: e?.durationMinutes.toString() ?? '',
    );
    _priceCtrl = TextEditingController(
      text: e?.priceEtb != null ? e!.priceEtb!.toStringAsFixed(0) : '',
    );
    _descriptionCtrl = TextEditingController(text: e?.descriptionEn ?? '');
  }

  @override
  void dispose() {
    _nameCtrl.dispose();
    _durationCtrl.dispose();
    _priceCtrl.dispose();
    _descriptionCtrl.dispose();
    super.dispose();
  }

  // Validation helpers --------------------------------------------------------

  String? _validateRequired(String? v, String label) {
    if (v == null || v.trim().isEmpty) return '$label is required.';
    return null;
  }

  String? _validateDuration(String? v) {
    if (v == null || v.trim().isEmpty) return 'Duration is required.';
    final n = int.tryParse(v.trim());
    if (n == null) return 'Use a whole number of minutes.';
    if (n <= 0) return 'Duration must be greater than 0.';
    if (n > 720) return 'Maximum duration is 720 minutes (12 hours).';
    return null;
  }

  String? _validatePrice(String? v) {
    if (v == null || v.trim().isEmpty) return null; // optional
    final n = double.tryParse(v.trim());
    if (n == null) return 'Use digits only (e.g. 250).';
    if (n < 0) return 'Price must be 0 or more.';
    return null;
  }

  // Submit --------------------------------------------------------------------

  Future<void> _submit() async {
    final ok = _formKey.currentState?.validate() ?? false;
    if (!ok) return;
    final duration = int.parse(_durationCtrl.text.trim());
    final priceText = _priceCtrl.text.trim();
    final price = priceText.isEmpty ? null : double.parse(priceText);
    final desc = _descriptionCtrl.text.trim();

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final Service result;
      if (widget.existing == null) {
        result = await widget.onSubmit(
          CreateServiceRequest(
            nameEn: _nameCtrl.text.trim(),
            durationMinutes: duration,
            descriptionEn: desc.isEmpty ? null : desc,
            priceEtb: price,
          ),
          null,
        );
      } else {
        result = await widget.onSubmit(
          null,
          UpdateServiceRequest(
            nameEn: _nameCtrl.text.trim(),
            durationMinutes: duration,
            descriptionEn: desc.isEmpty ? null : desc,
            clearDescription: desc.isEmpty,
            priceEtb: price,
            clearPrice: price == null,
          ),
        );
      }
      if (!mounted) return;
      Navigator.of(context).pop<Service?>(result);
    } on OwnerServicesFailure catch (e) {
      if (!mounted) return;
      setState(() => _error = e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isEdit = widget.existing != null;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
        child: SingleChildScrollView(
          child: Form(
            key: _formKey,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isEdit ? 'Edit service' : 'Add service',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                if (_error != null) _ErrorBanner(error: _error!),
                TextFormField(
                  controller: _nameCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Service name',
                    hintText: 'e.g. Haircut',
                    border: OutlineInputBorder(),
                  ),
                  maxLength: 200,
                  validator: (v) => _validateRequired(v, 'Service name'),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        controller: _durationCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Duration (minutes)',
                          hintText: 'e.g. 30',
                          border: OutlineInputBorder(),
                        ),
                        keyboardType: TextInputType.number,
                        validator: _validateDuration,
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: TextFormField(
                        controller: _priceCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Price (ETB)',
                          hintText: 'optional',
                          border: OutlineInputBorder(),
                        ),
                        keyboardType: const TextInputType.numberWithOptions(
                          decimal: true,
                        ),
                        validator: _validatePrice,
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _descriptionCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Description (English)',
                    hintText: 'Optional. What does this service include?',
                    border: OutlineInputBorder(),
                    alignLabelWithHint: true,
                  ),
                  minLines: 2,
                  maxLines: 4,
                  maxLength: 2000,
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    OutlinedButton(
                      onPressed: _busy
                          ? null
                          : () => Navigator.of(context).pop<Service?>(),
                      child: const Text('Cancel'),
                    ),
                    const Spacer(),
                    FilledButton.icon(
                      onPressed: _busy ? null : _submit,
                      icon: _busy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Icon(isEdit ? Icons.save : Icons.add),
                      label: Text(isEdit ? 'Save changes' : 'Create'),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.error});
  final OwnerServicesFailure error;

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
        ],
      ),
    );
  }

  (String, String) _copyFor(OwnerServicesFailure e) {
    switch (e.kind) {
      case OwnerServicesFailureKind.validation:
        return ('Check your details', e.message);
      case OwnerServicesFailureKind.forbidden:
        return (
          'Access denied',
          'Your role may have changed. Sign out and back in, then try again.',
        );
      case OwnerServicesFailureKind.unauthenticated:
        return (
          'Sign in required',
          'Your session expired. Sign in again to continue.',
        );
      case OwnerServicesFailureKind.conflict:
        return (
          'Conflicting state',
          'The service is in a state that blocks this change.',
        );
      case OwnerServicesFailureKind.notFound:
        return (
          'Not found',
          'This service no longer exists. Cancel and refresh.',
        );
      case OwnerServicesFailureKind.network:
        return ("Can't reach the server", 'Check your connection and retry.');
      case OwnerServicesFailureKind.serverError:
        return ('Something went wrong', 'Please try again in a moment.');
      case OwnerServicesFailureKind.malformedResponse:
      case OwnerServicesFailureKind.other:
        return ('Something went wrong', e.message);
    }
  }
}
