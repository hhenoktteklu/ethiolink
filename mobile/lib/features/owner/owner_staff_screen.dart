// EthioLink Mobile — owner staff CRUD screen.
//
// Phase 9 Track 3.5 fourth commit. Replaces the dashboard Staff
// card's SnackBar placeholder with a real screen, mirroring the
// `OwnerServicesScreen` shape:
//
//   * List the business's active staff. Every row shows display
//     name + role + active/inactive chip. Row tap → edit modal;
//     trash icon → confirm-then-DELETE.
//   * Create via the `_StaffFormSheet` bottom sheet (FAB).
//   * Edit via the same sheet, pre-populated from the row.
//   * Soft-delete via a confirmation dialog → DELETE.
//
// Wired into `OwnerDashboard` — tapping the Staff card pushes
// this widget with the business id pulled off the loaded
// `OwnerBusinessView`.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/models/staff.dart';
import 'data/owner_staff_repository.dart';

class OwnerStaffScreen extends StatefulWidget {
  const OwnerStaffScreen({
    required this.businessId,
    this.repositoryOverride,
    super.key,
  });

  /// The business whose staff we manage. Read from the loaded
  /// `OwnerBusinessView` at the call site.
  final String businessId;

  /// Test seam — production constructs `HttpOwnerStaffRepository`
  /// from the `AppConfigScope` `AppConfig`.
  final OwnerStaffRepository? repositoryOverride;

  @override
  State<OwnerStaffScreen> createState() => _OwnerStaffScreenState();
}

class _OwnerStaffScreenState extends State<OwnerStaffScreen> {
  OwnerStaffRepository? _repo;
  Future<List<Staff>>? _future;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_repo != null) return;
    _repo = widget.repositoryOverride ??
        HttpOwnerStaffRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _refresh();
  }

  void _refresh() {
    setState(() {
      _future = _repo!.listStaff(widget.businessId);
    });
  }

  // -------------------------------------------------------------------------
  // Sheet driver — `null` editing → create; non-null → edit.
  // -------------------------------------------------------------------------

  Future<void> _openForm({Staff? editing}) async {
    final result = await showModalBottomSheet<Staff?>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) {
        return Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(sheetContext).viewInsets.bottom,
          ),
          child: _StaffFormSheet(
            existing: editing,
            onSubmit: (CreateStaffRequest? create,
                UpdateStaffRequest? patch) async {
              if (editing == null) {
                return _repo!.createStaff(widget.businessId, create!);
              }
              return _repo!.updateStaff(
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

  Future<void> _confirmDeactivate(Staff staff) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('Deactivate staff member?'),
          content: Text(
            'Customers will no longer be able to book "${staff.displayName}". '
            'Existing appointments are not affected. You can recreate the '
            'staff member later if needed.',
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
      await _repo!.deactivateStaff(widget.businessId, staff.id);
      if (!mounted) return;
      _refresh();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('"${staff.displayName}" deactivated.'),
          duration: const Duration(seconds: 2),
        ),
      );
    } on OwnerStaffFailure catch (e) {
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
      appBar: AppBar(title: const Text('Staff')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openForm(),
        icon: const Icon(Icons.add),
        label: const Text('Add staff'),
      ),
      body: RefreshIndicator(
        onRefresh: () async {
          _refresh();
          try {
            await _future;
          } catch (_) {/* surfaced in FutureBuilder */}
        },
        child: FutureBuilder<List<Staff>>(
          future: _future,
          builder: (context, snap) {
            if (snap.connectionState == ConnectionState.waiting) {
              return const _Loading();
            }
            if (snap.hasError) {
              return _ErrorBranch(error: snap.error!, onRetry: _refresh);
            }
            final staff = snap.data ?? <Staff>[];
            if (staff.isEmpty) return const _EmptyState();
            return ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
              itemCount: staff.length,
              separatorBuilder: (_, __) => const SizedBox(height: 8),
              itemBuilder: (context, i) {
                final s = staff[i];
                return _StaffRow(
                  staff: s,
                  onEdit: () => _openForm(editing: s),
                  onDeactivate:
                      s.isActive ? () => _confirmDeactivate(s) : null,
                );
              },
            );
          },
        ),
      ),
    );
  }

  /// One-line SnackBar copy for the deactivate path. Mirrors the
  /// equivalent helper on `OwnerServicesScreen`.
  String _topErrorCopy(OwnerStaffFailure e) {
    switch (e.kind) {
      case OwnerStaffFailureKind.network:
        return "Can't reach the server. Try again in a moment.";
      case OwnerStaffFailureKind.forbidden:
        return 'Access denied — sign out and back in to refresh your role.';
      case OwnerStaffFailureKind.unauthenticated:
        return 'Sign in again to continue.';
      case OwnerStaffFailureKind.notFound:
        return 'This staff member no longer exists. Pull to refresh.';
      case OwnerStaffFailureKind.conflict:
        return 'The staff member is in a conflicting state.';
      case OwnerStaffFailureKind.validation:
        return e.message;
      case OwnerStaffFailureKind.serverError:
      case OwnerStaffFailureKind.malformedResponse:
      case OwnerStaffFailureKind.other:
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
        Icon(Icons.badge_outlined, size: 72, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'No staff yet',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Add the people customers can book — stylists, barbers, therapists, '
          'anyone who performs services. Tap "Add staff" to start.',
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
    final isNetwork = error is OwnerStaffFailure &&
        (error as OwnerStaffFailure).kind == OwnerStaffFailureKind.network;
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
          isNetwork ? "Can't reach the server" : 'Could not load staff',
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

class _StaffRow extends StatelessWidget {
  const _StaffRow({
    required this.staff,
    required this.onEdit,
    required this.onDeactivate,
  });

  final Staff staff;
  final VoidCallback onEdit;

  /// `null` → row already inactive; the deactivate action hides.
  final VoidCallback? onDeactivate;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
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
              CircleAvatar(
                backgroundColor: colors.primaryContainer,
                child: Text(
                  staff.displayName.characters.first.toUpperCase(),
                  style: TextStyle(color: colors.onPrimaryContainer),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            staff.displayName,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                        ),
                        _StatusChip(active: staff.isActive),
                      ],
                    ),
                    if (staff.role != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        staff.role!,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                              color: colors.onSurfaceVariant,
                            ),
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
// Staff form modal — shared between create + edit
// ---------------------------------------------------------------------------

class _StaffFormSheet extends StatefulWidget {
  const _StaffFormSheet({
    required this.existing,
    required this.onSubmit,
  });

  final Staff? existing;
  final Future<Staff> Function(
    CreateStaffRequest? create,
    UpdateStaffRequest? patch,
  ) onSubmit;

  @override
  State<_StaffFormSheet> createState() => _StaffFormSheetState();
}

class _StaffFormSheetState extends State<_StaffFormSheet> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _displayNameCtrl;
  late final TextEditingController _roleCtrl;

  bool _busy = false;
  OwnerStaffFailure? _error;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    _displayNameCtrl = TextEditingController(text: e?.displayName ?? '');
    _roleCtrl = TextEditingController(text: e?.role ?? '');
  }

  @override
  void dispose() {
    _displayNameCtrl.dispose();
    _roleCtrl.dispose();
    super.dispose();
  }

  String? _validateRequired(String? v, String label) {
    if (v == null || v.trim().isEmpty) return '$label is required.';
    return null;
  }

  Future<void> _submit() async {
    final ok = _formKey.currentState?.validate() ?? false;
    if (!ok) return;
    final name = _displayNameCtrl.text.trim();
    final role = _roleCtrl.text.trim();

    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final Staff result;
      if (widget.existing == null) {
        result = await widget.onSubmit(
          CreateStaffRequest(
            displayName: name,
            role: role.isEmpty ? null : role,
          ),
          null,
        );
      } else {
        result = await widget.onSubmit(
          null,
          UpdateStaffRequest(
            displayName: name,
            role: role.isEmpty ? null : role,
            clearRole: role.isEmpty,
          ),
        );
      }
      if (!mounted) return;
      Navigator.of(context).pop<Staff?>(result);
    } on OwnerStaffFailure catch (e) {
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
                  isEdit ? 'Edit staff member' : 'Add staff',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 12),
                if (_error != null) _ErrorBanner(error: _error!),
                TextFormField(
                  controller: _displayNameCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Display name',
                    hintText: 'e.g. Selam Tadesse',
                    border: OutlineInputBorder(),
                  ),
                  maxLength: 200,
                  validator: (v) => _validateRequired(v, 'Display name'),
                ),
                const SizedBox(height: 12),
                TextFormField(
                  controller: _roleCtrl,
                  decoration: const InputDecoration(
                    labelText: 'Role',
                    hintText: 'Optional. e.g. Senior Stylist',
                    border: OutlineInputBorder(),
                  ),
                  maxLength: 100,
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    OutlinedButton(
                      onPressed: _busy
                          ? null
                          : () => Navigator.of(context).pop<Staff?>(),
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
  final OwnerStaffFailure error;

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

  (String, String) _copyFor(OwnerStaffFailure e) {
    switch (e.kind) {
      case OwnerStaffFailureKind.validation:
        return ('Check your details', e.message);
      case OwnerStaffFailureKind.forbidden:
        return (
          'Access denied',
          'Your role may have changed. Sign out and back in, then try again.',
        );
      case OwnerStaffFailureKind.unauthenticated:
        return (
          'Sign in required',
          'Your session expired. Sign in again to continue.',
        );
      case OwnerStaffFailureKind.conflict:
        return (
          'Conflicting state',
          'The staff member is in a state that blocks this change.',
        );
      case OwnerStaffFailureKind.notFound:
        return (
          'Not found',
          'This staff member no longer exists. Cancel and refresh.',
        );
      case OwnerStaffFailureKind.network:
        return ("Can't reach the server", 'Check your connection and retry.');
      case OwnerStaffFailureKind.serverError:
        return ('Something went wrong', 'Please try again in a moment.');
      case OwnerStaffFailureKind.malformedResponse:
      case OwnerStaffFailureKind.other:
        return ('Something went wrong', e.message);
    }
  }
}
