// EthioLink Mobile — owner availability editor.
//
// Phase 9 Track 3.5 fifth commit. Replaces the dashboard
// Availability card's SnackBar placeholder with a real per-staff
// weekly-schedule editor + closed-date override management.
//
// Layout (single scroll view):
//
//   * Staff dropdown at the top — picks which staff member the
//     editor targets. Loaded via the existing
//     `OwnerStaffRepository`. If the business has no active staff
//     the screen renders a "create staff first" empty state.
//   * Seven weekday cards (Sunday → Saturday). Each card lists
//     the existing weekly windows as start/end `HH:MM` text
//     fields with a delete icon, plus an "Add interval" button
//     that appends a fresh empty row.
//   * Save button — calls `replaceWeekly` with all 7 days as a
//     single transaction.
//   * Overrides section — read-only list of existing OVERRIDE
//     rows + a "Add closed date" button that opens a date picker
//     and POSTs a closed-day override (00:00–23:59 with
//     `isClosed: true`).
//
// Validation is inline per field:
//   * `HH:MM` regex on every start/end TextField.
//   * `end > start` when both are present and well-formed.
//
// Server-side validation surfaces via the failure-kind classifier
// `AvailabilityFailureKind` and renders in an error banner above
// the editor.

import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/config/app_config_scope.dart';
import '../browse/models/staff.dart';
import 'data/availability_repository.dart';
import 'data/owner_staff_repository.dart';
import 'models/availability.dart';

class OwnerAvailabilityScreen extends StatefulWidget {
  const OwnerAvailabilityScreen({
    required this.businessId,
    this.staffRepositoryOverride,
    this.availabilityRepositoryOverride,
    super.key,
  });

  final String businessId;

  /// Test seam — fed into the staff dropdown loader.
  final OwnerStaffRepository? staffRepositoryOverride;

  /// Test seam — drives the actual schedule fetch / save / override.
  final AvailabilityRepository? availabilityRepositoryOverride;

  @override
  State<OwnerAvailabilityScreen> createState() =>
      _OwnerAvailabilityScreenState();
}

class _OwnerAvailabilityScreenState extends State<OwnerAvailabilityScreen> {
  OwnerStaffRepository? _staffRepo;
  AvailabilityRepository? _availRepo;

  Future<List<Staff>>? _staffFuture;
  Staff? _selectedStaff;

  AvailabilitySchedule? _schedule;
  bool _loadingSchedule = false;
  AvailabilityFailure? _scheduleError;

  /// Editor state — 7 lists of editable windows, one per weekday.
  /// Built from `_schedule` whenever a fetch completes.
  List<List<_EditableWindow>> _editor = List.generate(7, (_) => []);

  bool _saving = false;
  AvailabilityFailure? _saveError;
  String? _saveMessage;

  bool _addingOverride = false;
  AvailabilityFailure? _overrideError;

  static const _weekdayNames = <String>[
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ];

  /// Loose `HH:MM` matcher. Accepts `00:00` through `23:59`. The
  /// server also accepts `HH:MM:SS` but the editor emits `HH:MM`.
  static final _hhmm = RegExp(r'^([01][0-9]|2[0-3]):[0-5][0-9]$');

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_staffRepo != null) return;
    _staffRepo = widget.staffRepositoryOverride ??
        HttpOwnerStaffRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _availRepo = widget.availabilityRepositoryOverride ??
        HttpAvailabilityRepository(
          ApiClient(config: AppConfigScope.of(context)),
        );
    _staffFuture = _staffRepo!.listStaff(widget.businessId);
  }

  @override
  void dispose() {
    for (final day in _editor) {
      for (final w in day) {
        w.dispose();
      }
    }
    super.dispose();
  }

  // -------------------------------------------------------------------------
  // Schedule load + editor seeding
  // -------------------------------------------------------------------------

  Future<void> _loadSchedule(Staff staff) async {
    setState(() {
      _selectedStaff = staff;
      _loadingSchedule = true;
      _scheduleError = null;
      _schedule = null;
      _saveMessage = null;
    });
    try {
      final sch =
          await _availRepo!.getSchedule(widget.businessId, staff.id);
      if (!mounted) return;
      setState(() {
        _schedule = sch;
        _editor = _editorFromSchedule(sch);
      });
    } on AvailabilityFailure catch (e) {
      if (!mounted) return;
      setState(() => _scheduleError = e);
    } finally {
      if (mounted) setState(() => _loadingSchedule = false);
    }
  }

  List<List<_EditableWindow>> _editorFromSchedule(AvailabilitySchedule s) {
    // Dispose any stale controllers from a previous fetch.
    for (final day in _editor) {
      for (final w in day) {
        w.dispose();
      }
    }
    final grouped = s.weeklyByDay();
    return [
      for (final dayList in grouped)
        [
          for (final w in dayList)
            _EditableWindow(start: w.startTimeShort, end: w.endTimeShort),
        ],
    ];
  }

  // -------------------------------------------------------------------------
  // Editor mutations
  // -------------------------------------------------------------------------

  void _addWindow(int weekday) {
    setState(() {
      _editor[weekday].add(_EditableWindow(start: '', end: ''));
    });
  }

  void _removeWindow(int weekday, int index) {
    setState(() {
      _editor[weekday][index].dispose();
      _editor[weekday].removeAt(index);
    });
  }

  // -------------------------------------------------------------------------
  // Save (PUT)
  // -------------------------------------------------------------------------

  String? _validateEditor() {
    for (var d = 0; d < 7; d++) {
      for (var i = 0; i < _editor[d].length; i++) {
        final w = _editor[d][i];
        final s = w.startCtrl.text.trim();
        final e = w.endCtrl.text.trim();
        if (s.isEmpty || e.isEmpty) {
          return '${_weekdayNames[d]} interval ${i + 1}: '
              'both start and end times are required.';
        }
        if (!_hhmm.hasMatch(s) || !_hhmm.hasMatch(e)) {
          return '${_weekdayNames[d]} interval ${i + 1}: '
              'use HH:MM (e.g. 09:00).';
        }
        if (e.compareTo(s) <= 0) {
          return '${_weekdayNames[d]} interval ${i + 1}: '
              'end time must be after start time.';
        }
      }
    }
    return null;
  }

  Future<void> _save() async {
    final staff = _selectedStaff;
    if (staff == null) return;
    final err = _validateEditor();
    if (err != null) {
      setState(() => _saveError = AvailabilityFailure(
            kind: AvailabilityFailureKind.validation,
            message: err,
          ));
      return;
    }
    setState(() {
      _saving = true;
      _saveError = null;
      _saveMessage = null;
    });
    try {
      final days = <WeeklyDayInput>[
        for (var d = 0; d < 7; d++)
          WeeklyDayInput(
            weekday: d,
            windows: [
              for (final w in _editor[d])
                WeeklyWindowInput(
                  startTime: w.startCtrl.text.trim(),
                  endTime: w.endCtrl.text.trim(),
                ),
            ],
          ),
      ];
      final sch = await _availRepo!.replaceWeekly(
        widget.businessId,
        staff.id,
        days,
      );
      if (!mounted) return;
      setState(() {
        _schedule = sch;
        _editor = _editorFromSchedule(sch);
        _saveMessage = 'Schedule saved.';
      });
    } on AvailabilityFailure catch (e) {
      if (!mounted) return;
      setState(() => _saveError = e);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  // -------------------------------------------------------------------------
  // Add closed-date override
  // -------------------------------------------------------------------------

  Future<void> _addClosedOverride() async {
    final staff = _selectedStaff;
    if (staff == null) return;
    final picked = await showDatePicker(
      context: context,
      initialDate: DateTime.now(),
      firstDate: DateTime.now().subtract(const Duration(days: 1)),
      lastDate: DateTime.now().add(const Duration(days: 365)),
      helpText: 'Pick a date to mark closed',
    );
    if (picked == null || !mounted) return;
    final iso =
        '${picked.year.toString().padLeft(4, '0')}-'
        '${picked.month.toString().padLeft(2, '0')}-'
        '${picked.day.toString().padLeft(2, '0')}';
    setState(() {
      _addingOverride = true;
      _overrideError = null;
    });
    try {
      await _availRepo!.addOverride(
        widget.businessId,
        staff.id,
        AvailabilityOverrideRequest(
          specificDate: iso,
          startTime: '00:00',
          endTime: '23:59',
          isClosed: true,
        ),
      );
      // Re-fetch the full schedule so the overrides list reflects
      // the new row in server order.
      final sch =
          await _availRepo!.getSchedule(widget.businessId, staff.id);
      if (!mounted) return;
      setState(() {
        _schedule = sch;
      });
    } on AvailabilityFailure catch (e) {
      if (!mounted) return;
      setState(() => _overrideError = e);
    } finally {
      if (mounted) setState(() => _addingOverride = false);
    }
  }

  // -------------------------------------------------------------------------
  // Build
  // -------------------------------------------------------------------------

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Availability')),
      body: FutureBuilder<List<Staff>>(
        future: _staffFuture,
        builder: (context, staffSnap) {
          if (staffSnap.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (staffSnap.hasError) {
            return _StaffErrorBranch(
              error: staffSnap.error!,
              onRetry: () {
                setState(() {
                  _staffFuture = _staffRepo!.listStaff(widget.businessId);
                });
              },
            );
          }
          final staff = staffSnap.data ?? const <Staff>[];
          if (staff.isEmpty) return const _NoStaffPrompt();
          return _buildEditor(staff);
        },
      ),
    );
  }

  Widget _buildEditor(List<Staff> staff) {
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
      children: [
        DropdownButtonFormField<String>(
          initialValue: _selectedStaff?.id,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: 'Staff member',
            border: OutlineInputBorder(),
          ),
          items: [
            for (final s in staff)
              DropdownMenuItem(value: s.id, child: Text(s.displayName)),
          ],
          onChanged: (id) {
            if (id == null) return;
            final picked = staff.firstWhere((s) => s.id == id);
            _loadSchedule(picked);
          },
        ),
        const SizedBox(height: 12),
        if (_selectedStaff == null)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 24),
            child: Center(
              child: Text(
                'Pick a staff member to edit their schedule.',
                style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                      color: Theme.of(context).colorScheme.onSurfaceVariant,
                    ),
              ),
            ),
          )
        else if (_loadingSchedule)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 48),
            child: Center(child: CircularProgressIndicator()),
          )
        else if (_scheduleError != null)
          _InlineError(error: _scheduleError!)
        else
          ..._scheduleEditor(),
      ],
    );
  }

  List<Widget> _scheduleEditor() {
    return [
      if (_saveError != null) _InlineError(error: _saveError!),
      if (_saveMessage != null)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Text(
            _saveMessage!,
            style: TextStyle(color: Theme.of(context).colorScheme.primary),
          ),
        ),
      for (var d = 0; d < 7; d++) _DayCard(
        weekdayName: _weekdayNames[d],
        windows: _editor[d],
        onAdd: () => _addWindow(d),
        onRemove: (i) => _removeWindow(d, i),
      ),
      const SizedBox(height: 16),
      Center(
        child: FilledButton.icon(
          onPressed: _saving ? null : _save,
          icon: _saving
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.save),
          label: const Text('Save weekly schedule'),
        ),
      ),
      const SizedBox(height: 24),
      _overridesSection(),
    ];
  }

  Widget _overridesSection() {
    final colors = Theme.of(context).colorScheme;
    final overrides = _schedule?.overrides ?? const <AvailabilityWindow>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Date overrides',
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Mark specific dates as closed (holidays, time off). '
          'Open-date overrides land in a later commit.',
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
        const SizedBox(height: 8),
        if (_overrideError != null) _InlineError(error: _overrideError!),
        if (overrides.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: Text(
              'No overrides yet.',
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                    color: colors.onSurfaceVariant,
                  ),
            ),
          )
        else
          ...overrides.map((o) => _OverrideRow(window: o)),
        const SizedBox(height: 8),
        Align(
          alignment: Alignment.centerLeft,
          child: OutlinedButton.icon(
            onPressed: _addingOverride ? null : _addClosedOverride,
            icon: _addingOverride
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.event_busy),
            label: const Text('Add closed date'),
          ),
        ),
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Editable-window state
// ---------------------------------------------------------------------------

class _EditableWindow {
  _EditableWindow({required String start, required String end})
      : startCtrl = TextEditingController(text: start),
        endCtrl = TextEditingController(text: end);
  final TextEditingController startCtrl;
  final TextEditingController endCtrl;
  void dispose() {
    startCtrl.dispose();
    endCtrl.dispose();
  }
}

// ---------------------------------------------------------------------------
// Sub-widgets
// ---------------------------------------------------------------------------

class _DayCard extends StatelessWidget {
  const _DayCard({
    required this.weekdayName,
    required this.windows,
    required this.onAdd,
    required this.onRemove,
  });

  final String weekdayName;
  final List<_EditableWindow> windows;
  final VoidCallback onAdd;
  final void Function(int index) onRemove;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Card(
      elevation: 0,
      color: colors.surfaceContainerHighest,
      margin: const EdgeInsets.only(bottom: 8),
      child: Padding(
        padding: const EdgeInsets.all(12),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    weekdayName,
                    style: Theme.of(context).textTheme.titleMedium,
                  ),
                ),
                if (windows.isEmpty)
                  Text(
                    'CLOSED',
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                          color: colors.onSurfaceVariant,
                          letterSpacing: 0.5,
                        ),
                  ),
              ],
            ),
            const SizedBox(height: 4),
            for (var i = 0; i < windows.length; i++)
              Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: windows[i].startCtrl,
                        decoration: const InputDecoration(
                          labelText: 'Start',
                          hintText: 'HH:MM',
                          isDense: true,
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    const Text('–'),
                    const SizedBox(width: 8),
                    Expanded(
                      child: TextField(
                        controller: windows[i].endCtrl,
                        decoration: const InputDecoration(
                          labelText: 'End',
                          hintText: 'HH:MM',
                          isDense: true,
                          border: OutlineInputBorder(),
                        ),
                      ),
                    ),
                    IconButton(
                      tooltip: 'Remove',
                      icon: const Icon(Icons.delete_outline),
                      onPressed: () => onRemove(i),
                    ),
                  ],
                ),
              ),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: onAdd,
                icon: const Icon(Icons.add),
                label: const Text('Add interval'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _OverrideRow extends StatelessWidget {
  const _OverrideRow({required this.window});
  final AvailabilityWindow window;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final label = window.isClosed
        ? 'CLOSED · ${window.specificDate}'
        : '${window.specificDate} · ${window.startTimeShort}–${window.endTimeShort}';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Icon(
            window.isClosed ? Icons.block : Icons.event_available,
            color: window.isClosed ? colors.error : colors.primary,
          ),
          const SizedBox(width: 8),
          Expanded(child: Text(label)),
        ],
      ),
    );
  }
}

class _InlineError extends StatelessWidget {
  const _InlineError({required this.error});
  final AvailabilityFailure error;

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

  (String, String) _copyFor(AvailabilityFailure e) {
    switch (e.kind) {
      case AvailabilityFailureKind.validation:
        return ('Check your schedule', e.message);
      case AvailabilityFailureKind.forbidden:
        return (
          'Access denied',
          'Your role may have changed. Sign out and back in to refresh.',
        );
      case AvailabilityFailureKind.unauthenticated:
        return ('Sign in required', 'Sign in again to continue.');
      case AvailabilityFailureKind.notFound:
        return ('Not found', e.message);
      case AvailabilityFailureKind.conflict:
        return ('Conflicting state', e.message);
      case AvailabilityFailureKind.network:
        return ("Can't reach the server", 'Check your connection and retry.');
      case AvailabilityFailureKind.serverError:
        return ('Something went wrong', 'Please try again in a moment.');
      case AvailabilityFailureKind.malformedResponse:
      case AvailabilityFailureKind.other:
        return ('Something went wrong', e.message);
    }
  }
}

class _StaffErrorBranch extends StatelessWidget {
  const _StaffErrorBranch({required this.error, required this.onRetry});
  final Object error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      physics: const AlwaysScrollableScrollPhysics(),
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.error_outline, size: 56, color: colors.error),
        const SizedBox(height: 12),
        Text(
          'Could not load staff',
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

class _NoStaffPrompt extends StatelessWidget {
  const _NoStaffPrompt();

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListView(
      padding: const EdgeInsets.fromLTRB(24, 48, 24, 32),
      children: [
        Icon(Icons.badge_outlined, size: 72, color: colors.primary),
        const SizedBox(height: 12),
        Text(
          'No active staff',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.titleMedium,
        ),
        const SizedBox(height: 4),
        Text(
          'Add staff before editing availability. The Staff card on the '
          'My Business dashboard manages your roster.',
          textAlign: TextAlign.center,
          style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                color: colors.onSurfaceVariant,
              ),
        ),
      ],
    );
  }
}
