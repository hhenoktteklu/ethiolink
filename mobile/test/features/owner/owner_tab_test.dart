// EthioLink Mobile — OwnerTab widget tests.

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:ethiolink/generated/l10n/app_localizations.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:ethiolink/core/config/app_config.dart';
import 'package:ethiolink/core/config/app_config_scope.dart';
import 'package:ethiolink/features/browse/data/categories_repository.dart';
import 'package:ethiolink/features/browse/models/business_detail.dart';
import 'package:ethiolink/features/browse/models/category.dart';
import 'package:ethiolink/features/owner/create_business_flow.dart';
import 'package:ethiolink/features/owner/data/business_actions_repository.dart';
import 'package:ethiolink/features/owner/data/featuring_repository.dart';
import 'package:ethiolink/features/owner/data/owner_business_repository.dart';
import 'package:ethiolink/features/owner/models/featuring.dart';
import 'package:ethiolink/features/owner/models/owner_business_view.dart';
import 'package:ethiolink/features/owner/owner_promote_screen.dart';
import 'package:ethiolink/features/owner/owner_tab.dart';

const _testConfig = AppConfig(
  apiBaseUrl: 'https://example.test',
  cognitoDomain: 'd',
  cognitoClientId: 'c',
  redirectUri: 'com.ethiolink.app:/oauthredirect',
);

OwnerBusinessView _sampleBusiness({
  String status = 'APPROVED',
  BusinessRejection? rejection,
  String? name = 'Sunset Salon',
  String? descriptionEn = 'Best in town.',
  String? city = 'Addis Ababa',
}) {
  return OwnerBusinessView(
    detail: BusinessDetail(
      id: 'biz-1',
      categoryId: 'cat-1',
      name: name,
      descriptionEn: descriptionEn,
      descriptionAm: null,
      city: city,
      addressLine: null,
      latitude: null,
      longitude: null,
      phone: null,
      telegramHandle: null,
      whatsappPhone: null,
      featuredUntil: null,
      ratingAvg: 4.5,
      ratingCount: 10,
    ),
    status: status,
    ownerUserId: 'owner-1',
    rejection: rejection,
  );
}

/// Test fake. Each constructor configures the next `getMine()`
/// call to either resolve, error, or stay pending.
///
/// `getMine()` builds a fresh Future on every invocation rather
/// than returning a pre-resolved `Completer.future`. Pre-resolving
/// the Future at constructor time leaves the error unhandled until
/// `FutureBuilder` subscribes — under the widget-test zone that's
/// enough for the runner to report the error as a test failure
/// before the inline error UI gets a chance to render. Using
/// `Future.microtask` defers the throw to the microtask queue,
/// guaranteeing the `FutureBuilder` has subscribed first.
class _FakeRepo implements OwnerBusinessRepository {
  _FakeRepo.value(OwnerBusinessView v)
      : _resolver = (() async => v),
        _controlled = null;
  _FakeRepo.error(Object e)
      : _resolver = (() => Future<OwnerBusinessView>.microtask(() {
              throw e;
            })),
        _controlled = null;

  /// Returns a future that stays pending until the test calls
  /// [complete] / [completeError]. The previous form exposed the
  /// raw `Completer` so the test could resolve it; the new factory
  /// keeps the resolver-function contract while still letting the
  /// loading test drive the completion timing explicitly.
  factory _FakeRepo.pending() {
    final controlled = Completer<OwnerBusinessView>();
    return _FakeRepo._controlledImpl(controlled);
  }

  _FakeRepo._controlledImpl(this._controlled)
      : _resolver = (() => _controlled!.future);

  final Future<OwnerBusinessView> Function() _resolver;
  final Completer<OwnerBusinessView>? _controlled;

  /// Resolves a `_FakeRepo.pending()` instance. No-op (with a clear
  /// assertion error) for `.value` / `.error` constructions.
  void complete(OwnerBusinessView v) {
    final c = _controlled;
    if (c == null || c.isCompleted) {
      throw StateError(
          '_FakeRepo.complete called on a non-pending or already-completed instance.');
    }
    c.complete(v);
  }

  @override
  Future<OwnerBusinessView> getMine() => _resolver();
}

/// Stub action repository for tests that exercise the submit path
/// or the create-business CTA. Tests that don't care just leave
/// it null and `_pump` constructs a no-op stub on the fly.
class _StubActionsRepo implements BusinessActionsRepository {
  _StubActionsRepo({this.submitResult});

  String? lastSubmitId;
  CreateBusinessRequest? lastCreateRequest;
  OwnerBusinessView? submitResult;

  @override
  Future<OwnerBusinessView> createBusiness(CreateBusinessRequest req) async {
    lastCreateRequest = req;
    throw UnimplementedError('createBusiness not exercised in this test');
  }

  @override
  Future<OwnerBusinessView> submitBusiness(String id) async {
    lastSubmitId = id;
    return submitResult!;
  }

  @override
  // Phase 9 Track 3.5 polish — interface added `updateBusiness` for
  // the owner profile editor. This suite covers the submit + create
  // CTA paths only, so the fake throws if it ever gets called.
  Future<OwnerBusinessView> updateBusiness(
    String businessId,
    PatchBusinessRequest request,
  ) async {
    throw UnimplementedError('updateBusiness not exercised in this test');
  }
}

class _FakeCategoriesRepo implements CategoriesRepository {
  _FakeCategoriesRepo(this.items);
  final List<Category> items;
  @override
  Future<List<Category>> list() async => items;
}

class _StubFeaturingRepo implements FeaturingRepository {
  @override
  Future<List<FeaturingPackage>> listPackages(String businessId) async =>
      const <FeaturingPackage>[];
  @override
  // Phase 10 — interface now returns `SubscribeFeaturingResult`
  // (subscription + payment summary). The owner-tab suite never
  // hits the subscribe path, so an `UnimplementedError` is still
  // the correct stand-in; only the return type needs to match.
  Future<SubscribeFeaturingResult> subscribe(
    String businessId,
    String packageCode,
  ) async =>
      throw UnimplementedError('not used');
  @override
  Future<FeaturingSubscription?> getActive(String businessId) async => null;
  @override
  Future<List<FeaturingSubscription>> listHistory(
    String businessId, {
    int? limit,
  }) async =>
      const <FeaturingSubscription>[];
}

Future<void> _pump(
  WidgetTester tester, {
  required OwnerBusinessRepository repo,
  BusinessActionsRepository? actionsRepo,
  CategoriesRepository? categoriesRepo,
  FeaturingRepository? featuringRepo,
  OwnerDashboardMode mode = OwnerDashboardMode.full,
}) async {
  // The owner tab renders the business card + status banner +
  // promote panel + bookings inbox in a scrollable column. A taller
  // viewport keeps everything in the laid-out region so
  // `find.text(...)` doesn't miss rows that landed below the 600px
  // default test viewport.
  tester.view.physicalSize = const Size(800, 2400);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);

  await tester.pumpWidget(
    AppConfigScope(
      config: _testConfig,
      child: MaterialApp(
        locale: const Locale('en'),
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        home: OwnerTab(
          mode: mode,
          repositoryOverride: repo,
          actionsRepositoryOverride: actionsRepo ?? _StubActionsRepo(),
          categoriesRepositoryOverride: categoriesRepo,
          featuringRepositoryOverride: featuringRepo,
        ),
      ),
    ),
  );
}

void main() {
  testWidgets('renders loading while the fetch is pending', (tester) async {
    final repo = _FakeRepo.pending();
    await _pump(tester, repo: repo);
    await tester.pump();
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    // Resolve the pending future via the fake's public seam so the
    // tree settles cleanly before the test ends.
    repo.complete(_sampleBusiness());
    await tester.pumpAndSettle();
  });

  testWidgets('renders the dashboard for an APPROVED business', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'APPROVED')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Sunset Salon'), findsOneWidget);
    expect(find.text('APPROVED'), findsOneWidget);
    // Six dashboard cards (Promote sits between Profile and
    // Services).
    expect(find.text('Profile'), findsOneWidget);
    expect(find.text('Promote'), findsOneWidget);
    expect(find.text('Services'), findsOneWidget);
    expect(find.text('Staff'), findsOneWidget);
    expect(find.text('Availability'), findsOneWidget);
    expect(find.text('Bookings'), findsOneWidget);
    // No status banner on APPROVED.
    expect(find.text('Awaiting review'), findsNothing);
    expect(find.text('Draft'), findsNothing);
  });

  testWidgets('tapping Promote pushes OwnerPromoteScreen', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'APPROVED')),
      featuringRepo: _StubFeaturingRepo(),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('Promote'));
    await tester.pumpAndSettle();

    expect(find.byType(OwnerPromoteScreen), findsOneWidget);
  });

  testWidgets('renders the PENDING_REVIEW banner', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'PENDING_REVIEW')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Awaiting review'), findsOneWidget);
    expect(find.textContaining('admin is reviewing'), findsOneWidget);
  });

  testWidgets('renders the DRAFT submittable banner', (tester) async {
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'DRAFT')),
    );
    await tester.pumpAndSettle();

    expect(find.text('Draft'), findsOneWidget);
    expect(
      find.widgetWithText(FilledButton, 'Submit for review'),
      findsOneWidget,
    );
  });

  testWidgets(
    'DRAFT with missing required fields renders the checklist + disables submit',
    (tester) async {
      // All three Profile-required fields blanked. Pumped in
      // dashboardOnly mode (the Dashboard tab) so the checklist
      // is the only "Profile" on screen — the setup cards (which
      // also carry a "Profile" label) live on the separate Setup
      // tab and are exercised in their own test below.
      await _pump(
        tester,
        mode: OwnerDashboardMode.dashboardOnly,
        repo: _FakeRepo.value(_sampleBusiness(
          status: 'DRAFT',
          name: null,
          descriptionEn: null,
          city: null,
        )),
        actionsRepo: _StubActionsRepo(),
      );
      await tester.pumpAndSettle();

      // The structural key the checklist attaches.
      expect(find.byKey(const Key('ownerSubmitChecklist')), findsOneWidget);
      expect(
        find.text('Complete these before submitting'),
        findsOneWidget,
      );
      // Section header + every blocked field row. "Profile" is
      // unambiguous here — no setup cards in dashboardOnly mode.
      expect(find.text('Profile'), findsOneWidget);
      expect(find.text('Business name'), findsOneWidget);
      expect(find.text('Description'), findsOneWidget);
      expect(find.text('City'), findsOneWidget);
      // Submit button is rendered but disabled (onPressed: null).
      final btn = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Submit for review'),
      );
      expect(btn.onPressed, isNull);
      // The vague backend-style message text must NOT appear —
      // the structured checklist replaced it.
      expect(
        find.textContaining('missing required fields for submission'),
        findsNothing,
      );
    },
  );

  testWidgets(
    'Setup tab Profile card shows the "Missing info" chip when incomplete',
    (tester) async {
      // The Missing-info chip is a Setup-tab (setupOnly) concern —
      // it sits on the Profile card. The Dashboard tab (above)
      // owns the checklist; the Setup tab owns the per-card chip.
      await _pump(
        tester,
        mode: OwnerDashboardMode.setupOnly,
        repo: _FakeRepo.value(_sampleBusiness(
          status: 'DRAFT',
          city: '',
        )),
        actionsRepo: _StubActionsRepo(),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('ownerCardMissingChip')), findsOneWidget);
      // setupOnly mode has no status banner, so no checklist + no
      // submit button here — those are the Dashboard tab's job.
      expect(find.byKey(const Key('ownerSubmitChecklist')), findsNothing);
      expect(
        find.widgetWithText(FilledButton, 'Submit for review'),
        findsNothing,
      );
    },
  );

  testWidgets(
    'DRAFT with partial missing renders only the affected checklist rows',
    (tester) async {
      // Only City missing. Owner sees just the City row under
      // Profile; no Business-name / Description rows. dashboardOnly
      // so "City" is unambiguous (no Availability/etc. cards).
      await _pump(
        tester,
        mode: OwnerDashboardMode.dashboardOnly,
        repo: _FakeRepo.value(_sampleBusiness(
          status: 'DRAFT',
          city: '',
        )),
        actionsRepo: _StubActionsRepo(),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('ownerSubmitChecklist')), findsOneWidget);
      expect(find.text('City'), findsOneWidget);
      expect(find.text('Business name'), findsNothing);
      expect(find.text('Description'), findsNothing);
    },
  );

  testWidgets(
    'fully-populated DRAFT shows no checklist + enabled submit',
    (tester) async {
      await _pump(
        tester,
        mode: OwnerDashboardMode.dashboardOnly,
        repo: _FakeRepo.value(_sampleBusiness(status: 'DRAFT')),
        actionsRepo: _StubActionsRepo(),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('ownerSubmitChecklist')), findsNothing);
      final btn = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Submit for review'),
      );
      expect(btn.onPressed, isNotNull);
    },
  );

  testWidgets(
    'tapping disabled Submit on incomplete DRAFT does NOT call the actions repo',
    (tester) async {
      final actions = _StubActionsRepo();
      await _pump(
        tester,
        mode: OwnerDashboardMode.dashboardOnly,
        repo: _FakeRepo.value(_sampleBusiness(
          status: 'DRAFT',
          city: '',
        )),
        actionsRepo: actions,
      );
      await tester.pumpAndSettle();

      // Tap the button anyway — disabled buttons absorb the tap;
      // the repo must not see a submit call. This is the
      // defense-in-depth check: a bug that re-enables the
      // button programmatically (e.g. a future refactor) would
      // still fail this test because the readiness gate in
      // `_submit` is the failsafe.
      await tester.tap(
        find.widgetWithText(FilledButton, 'Submit for review'),
      );
      await tester.pumpAndSettle();

      expect(actions.lastSubmitId, isNull);
    },
  );

  testWidgets(
    'renders the REJECTED banner with the admin note when '
    'OwnerBusinessView.rejection carries a reason',
    (tester) async {
      // The me.business handler populates rejection from the most-
      // recent REJECT_BUSINESS row in admin_actions. The banner
      // surfaces the admin's note inline in a distinct sub-container
      // so the owner sees the exact feedback to fix.
      await _pump(
        tester,
        repo: _FakeRepo.value(_sampleBusiness(
          status: 'REJECTED',
          rejection: const BusinessRejection(
            reason:
                'Business license photo is unreadable. Please re-upload '
                'a clearer scan.',
            rejectedAt: '2026-05-13T09:00:00.000Z',
          ),
        )),
        actionsRepo: _StubActionsRepo(),
      );
      await tester.pumpAndSettle();

      expect(find.text('Rejected'), findsOneWidget);
      // The "Admin note" label sits above the reason copy in the
      // sub-container.
      expect(find.text('Admin note'), findsOneWidget);
      expect(
        find.textContaining('Business license photo is unreadable'),
        findsOneWidget,
      );
      // The structural key the banner attaches to the note
      // sub-container — guards against the layout regressing into
      // a generic Container without the differentiating treatment.
      expect(find.byKey(const Key('ownerRejectReason')), findsOneWidget);
      // Submit-for-review is still available so the owner can
      // resubmit after fixing the noted issue.
      expect(
        find.widgetWithText(FilledButton, 'Submit for review'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'REJECTED banner falls back to generic copy when rejection.reason '
    'is null (admin rejected without a note)',
    (tester) async {
      await _pump(
        tester,
        repo: _FakeRepo.value(_sampleBusiness(
          status: 'REJECTED',
          rejection: const BusinessRejection(
            reason: null,
            rejectedAt: '2026-05-13T09:00:00.000Z',
          ),
        )),
        actionsRepo: _StubActionsRepo(),
      );
      await tester.pumpAndSettle();

      expect(find.text('Rejected'), findsOneWidget);
      // Generic copy from the no-note branch.
      expect(
        find.textContaining('Fix the noted issues'),
        findsOneWidget,
      );
      // The "Admin note" sub-container is hidden when there's no
      // reason to show.
      expect(find.byKey(const Key('ownerRejectReason')), findsNothing);
      expect(find.text('Admin note'), findsNothing);
    },
  );

  testWidgets('DRAFT banner submit button calls the actions repo',
      (tester) async {
    final actions = _StubActionsRepo(
      submitResult: _sampleBusiness(status: 'PENDING_REVIEW'),
    );
    await _pump(
      tester,
      repo: _FakeRepo.value(_sampleBusiness(status: 'DRAFT')),
      actionsRepo: actions,
    );
    await tester.pumpAndSettle();

    await tester.tap(find.widgetWithText(FilledButton, 'Submit for review'));
    await tester.pumpAndSettle();

    expect(actions.lastSubmitId, 'biz-1');
  });

  testWidgets('tapping "Create your business" pushes CreateBusinessFlow',
      (tester) async {
    final repo = _FakeRepo.error(
      OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.notFound,
        message: 'no business',
        statusCode: 404,
      ),
    );
    await _pump(
      tester,
      repo: repo,
      actionsRepo: _StubActionsRepo(),
      categoriesRepo: _FakeCategoriesRepo(const []),
    );
    await tester.pumpAndSettle();

    await tester.tap(
      find.widgetWithText(FilledButton, 'Create your business'),
    );
    await tester.pumpAndSettle();

    // CreateBusinessFlow is on top of the stack.
    expect(find.byType(CreateBusinessFlow), findsOneWidget);
    expect(find.text('Tell us about your business'), findsOneWidget);
  });

  testWidgets('renders the create-business CTA on 404', (tester) async {
    final repo = _FakeRepo.error(
      OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.notFound,
        message: 'no business',
        statusCode: 404,
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('No business yet'), findsOneWidget);
    expect(
      find.widgetWithText(FilledButton, 'Create your business'),
      findsOneWidget,
    );
  });

  testWidgets('renders the forbidden banner on 403', (tester) async {
    final repo = _FakeRepo.error(
      OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.forbidden,
        message: 'role drift',
        statusCode: 403,
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text('Access denied'), findsOneWidget);
    // The forbidden banner's body sentence reads
    // "...sign out and back in to refresh your role." — lowercase
    // `sign` because the phrase is mid-sentence. `textContaining`
    // is case-sensitive, so match the actual casing.
    expect(
      find.textContaining('sign out and back in'),
      findsOneWidget,
    );
  });

  testWidgets('renders the network error variant with retry', (tester) async {
    final repo = _FakeRepo.error(
      OwnerBusinessLoadFailure(
        kind: OwnerBusinessLoadFailureKind.network,
        message: 'fetch failed',
      ),
    );
    await _pump(tester, repo: repo);
    await tester.pumpAndSettle();

    expect(find.text("Can't reach the server"), findsOneWidget);
    expect(find.widgetWithText(FilledButton, 'Try again'), findsOneWidget);
  });
}
