// EthioLink — scheduled reminder lambda.
//
// EventBridge-driven Lambda invoked every 15 minutes (rule lives
// in `infra/terraform/modules/eventbridge/` — Terraform wiring
// is a Phase 7 commit, not this one). Each run scans ACCEPTED
// appointments whose `starts_at` falls in a fixed 15-minute slice
// 24 hours from now, then dispatches two reminder notifications
// per appointment — one for the customer and one for the
// business owner.
//
// Window arithmetic:
//
//   toUtc   = now + 24h00m  (exclusive)
//   fromUtc = now + 23h45m  (inclusive)
//
// At a 15-minute cadence, consecutive runs scan adjacent 15-min
// slices: 23:45 → 24:00, then 24:00 → 24:15 (well, 23:45 → 24:00
// in the next run's clock), etc. A jittered run that starts a
// minute late still covers the same logical slice because the
// idempotency check below dedupes by `(template_key,
// recipient_user_id, payload->>'startsAtUtc')`.
//
// Idempotency:
//
//   For each (appointment × template), call
//   `notificationLogRepository.existsForAppointmentSlot({...})`
//   before dispatching. If a row already exists at ANY status
//   (QUEUED / SENT / DELIVERED / FAILED), the reminder is
//   skipped. The "skip on FAILED" stance is documented in
//   `NotificationLogRepository.existsForAppointmentSlot` —
//   admins can manually clear a failed row to force a retry.
//   No `reminder_sent_at` column on `appointments`; the log
//   table IS the ledger.
//
// Error policy (matches PHASE_6_NOTIFICATIONS.md "Acceptance
// criteria"):
//
//   * The dispatcher already catches `NotificationGatewayError`
//     subclasses and persists FAILED. We treat `status: 'FAILED'`
//     from the returned log row as a `failed++` for the summary.
//   * Anything that escapes the dispatcher (a thrown
//     `UnknownTemplateKeyError`, `NotificationRecipientNotFoundError`,
//     `NoGatewayForChannelError`, or any `RepositoryError`
//     during the QUEUED insert) is caught at the per-recipient
//     loop boundary, counted as `failed++`, and logged. The
//     batch continues. A single broken recipient cannot poison
//     the whole window.
//
// Return value: a `ReminderBatchSummary` with counts the EventBridge
// rule's CloudWatch metric will eventually graph
// (`scanned` / `sent` / `skipped` / `failed`). The CloudWatch
// wiring is a Phase 7 concern; the summary is also returned
// directly from the handler so a manual `aws lambda invoke` shows
// the result.

import type { ScheduledEvent } from 'aws-lambda';

import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import type {
    Appointment,
    AppointmentsRepository,
} from '../../shared/domains/appointments/appointmentsRepository.js';
import { PgAppointmentsRepository } from '../../shared/domains/appointments/appointmentsRepository.js';
import type { BusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import type { NotificationLogRepository } from '../../shared/domains/notifications/notificationLogRepository.js';
import { PgNotificationLogRepository } from '../../shared/domains/notifications/notificationLogRepository.js';
import type { NotificationChannel } from '../../shared/adapters/notifications/NotificationGateway.js';
import type { NotificationService } from '../../shared/domains/notifications/notificationService.js';
import {
    createNotificationService,
    shouldWireSmsGateway,
    shouldWireTelegramGateway,
} from '../../shared/domains/notifications/notificationServiceFactory.js';
import type { BookingTemplateKey } from '../../shared/domains/notifications/templateRegistry.js';
import type { ServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import { PgServiceRepository } from '../../shared/domains/services/serviceRepository.js';
import type { User, UserRepository } from '../../shared/domains/users/userRepository.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import type { Logger } from '../../shared/logging/logger.js';
import { createLogger } from '../../shared/logging/logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Reminder lead time: how far in advance of `starts_at` we ping. */
const REMINDER_LEAD_MINUTES = 24 * 60;
/**
 * Width of the slice each scan covers. Matches the EventBridge
 * cadence (every 15 minutes). Two consecutive scans at exactly
 * 15-minute spacing tile the future timeline without overlap;
 * jitter is absorbed by the idempotency check.
 */
const REMINDER_WINDOW_MINUTES = 15;
/**
 * Row cap per scan. MVP traffic produces nowhere near this — a
 * thousand ACCEPTED appointments in a single 15-minute slice
 * implies ~96k accepted bookings/day, which is several orders of
 * magnitude past current scale. The cap is a safety belt against
 * a runaway query, not a real pagination limit.
 */
const REMINDER_BATCH_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-run summary surfaced as the lambda return value.
 *
 *   * `scanned` — appointments in the window.
 *   * `sent`    — reminders successfully dispatched (one per
 *                 (appointment × template), so each appointment
 *                 contributes 0..2 to this counter).
 *   * `skipped` — reminders skipped because a
 *                 `notification_logs` row already exists for the
 *                 (template × recipient × startsAt) triple.
 *   * `failed`  — reminders that landed as FAILED OR threw an
 *                 internal error. Same counting unit as `sent`.
 */
export interface ReminderBatchSummary {
    readonly scanned: number;
    readonly sent: number;
    readonly skipped: number;
    readonly failed: number;
}

export interface ReminderBatchDeps {
    readonly appointmentsRepo: AppointmentsRepository;
    readonly businessRepo: BusinessRepository;
    readonly serviceRepo: ServiceRepository;
    readonly userRepo: UserRepository;
    readonly notificationService: NotificationService;
    readonly notificationLogRepo: NotificationLogRepository;
    readonly logger: Logger;
    /** Test seam — defaults to `() => new Date()`. */
    readonly now?: () => Date;
    /**
     * Phase 9 — enables SMS routing for reminder dispatch. Same
     * lockstep boolean `AppointmentService` uses; the handler-side
     * derivation is `shouldWireSmsGateway(config)`. When `true`,
     * each reminder fetches the recipient's `users` row and routes
     * through `SMS` if the recipient has a non-empty `phone`,
     * falling back to `MOCK` otherwise. Defaults to `false` so
     * existing unit tests (which don't wire an SMS gateway) keep
     * routing through `MOCK` without any change.
     */
    readonly smsRoutingEnabled?: boolean;
    /**
     * Phase 9 Track 2 — enables Telegram routing for reminder
     * dispatch. Handler-side derivation is
     * `shouldWireTelegramGateway(config)`. Telegram is preferred
     * over SMS when both are enabled — see
     * `AppointmentService.pickNotificationChannel` for the
     * priority order. Defaults to `false`.
     */
    readonly telegramRoutingEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// Cold-start init
// ---------------------------------------------------------------------------

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const pool = getPool(config);
const appointmentsRepo = new PgAppointmentsRepository(pool);
const businessRepo = new PgBusinessRepository(pool);
const serviceRepo = new PgServiceRepository(pool);
const userRepo = new PgUserRepository(pool);
const notificationLogRepo = new PgNotificationLogRepository(pool);
const notificationService = createNotificationService({
    pool,
    config,
    logger: baseLogger,
});

// ---------------------------------------------------------------------------
// Lambda entry
// ---------------------------------------------------------------------------

export const handler = async (
    event: ScheduledEvent,
): Promise<ReminderBatchSummary> => {
    const logger = baseLogger.child({
        handler: 'scheduled.sendReminders',
        ruleArn: event.resources?.[0],
    });

    return runReminderBatch({
        appointmentsRepo,
        businessRepo,
        serviceRepo,
        userRepo,
        notificationService,
        notificationLogRepo,
        logger,
        smsRoutingEnabled: shouldWireSmsGateway(config),
        telegramRoutingEnabled: shouldWireTelegramGateway(config),
    });
};

// ---------------------------------------------------------------------------
// Batch runner — exported for tests
// ---------------------------------------------------------------------------

/**
 * Run one scan of the reminder window. Pure dependency-injected
 * core so the unit test (`tests/notifications/sendReminders.test.ts`)
 * can call it directly without booting the Lambda runtime.
 *
 * The function NEVER throws on a per-recipient failure — the
 * batch is best-effort by design and the summary is the only
 * outcome surface. A truly unexpected exception (e.g. the initial
 * `listForReminderWindow` query throws) DOES propagate; the
 * Lambda layer above will surface that to CloudWatch and the
 * EventBridge retry policy will handle it.
 */
export async function runReminderBatch(
    deps: ReminderBatchDeps,
): Promise<ReminderBatchSummary> {
    const nowFn = deps.now ?? (() => new Date());
    const now = nowFn();

    const toUtc = new Date(now.getTime() + REMINDER_LEAD_MINUTES * 60_000);
    const fromUtc = new Date(
        toUtc.getTime() - REMINDER_WINDOW_MINUTES * 60_000,
    );

    const scanLog = deps.logger.child({
        windowFromUtc: fromUtc.toISOString(),
        windowToUtc: toUtc.toISOString(),
    });

    const appointments = await deps.appointmentsRepo.listForReminderWindow(
        fromUtc,
        toUtc,
        REMINDER_BATCH_LIMIT,
    );

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const appointment of appointments) {
        const business = await deps.businessRepo.findById(appointment.businessId);
        if (!business) {
            // The appointment is orphaned. Count both reminders as
            // failed — we can't construct a payload without the
            // business name, and dispatching against a deleted FK
            // would 500. Log and continue.
            scanLog.warn('Reminder skipped — business not found.', {
                appointmentId: appointment.id,
                businessId: appointment.businessId,
            });
            failed += 2;
            continue;
        }

        const service = await deps.serviceRepo.findById(appointment.serviceId);
        if (!service) {
            scanLog.warn('Reminder skipped — service not found.', {
                appointmentId: appointment.id,
                serviceId: appointment.serviceId,
            });
            failed += 2;
            continue;
        }

        // Customer display name only matters for the
        // business-side reminder; fetch once per appointment and
        // reuse below.
        const customer = await deps.userRepo.findById(appointment.customerId);

        const targets: ReadonlyArray<{
            templateKey: BookingTemplateKey;
            recipientUserId: string;
        }> = [
            {
                templateKey: 'booking.reminder.customer',
                recipientUserId: appointment.customerId,
            },
            {
                templateKey: 'booking.reminder.business',
                recipientUserId: business.ownerUserId,
            },
        ];

        for (const target of targets) {
            const result = await dispatchOneReminder({
                appointment,
                businessName: business.name ?? 'your business',
                serviceName: service.name.en,
                customerDisplayName: customer?.displayName ?? null,
                customer,
                target,
                deps,
                scanLog,
            });
            if (result === 'sent') sent += 1;
            else if (result === 'skipped') skipped += 1;
            else failed += 1;
        }
    }

    scanLog.info('Reminder scan complete.', {
        scanned: appointments.length,
        sent,
        skipped,
        failed,
    });

    return Object.freeze<ReminderBatchSummary>({
        scanned: appointments.length,
        sent,
        skipped,
        failed,
    });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

interface DispatchOneInput {
    readonly appointment: Appointment;
    readonly businessName: string;
    readonly serviceName: string;
    readonly customerDisplayName: string | null;
    /**
     * Phase 9 — preloaded customer row used by the channel-
     * selection helper to avoid a redundant `findById` when the
     * customer-side reminder's recipient IS this customer. The
     * batch loop fetches the customer once per appointment for
     * `customerDisplayName`; we reuse it here.
     */
    readonly customer: User | null;
    readonly target: {
        readonly templateKey: BookingTemplateKey;
        readonly recipientUserId: string;
    };
    readonly deps: ReminderBatchDeps;
    readonly scanLog: Logger;
}

type DispatchOutcome = 'sent' | 'skipped' | 'failed';

async function dispatchOneReminder(input: DispatchOneInput): Promise<DispatchOutcome> {
    const { appointment, deps, target, scanLog } = input;
    const startsAtUtc = appointment.startsAt.toISOString();

    try {
        const already = await deps.notificationLogRepo.existsForAppointmentSlot({
            templateKey: target.templateKey,
            recipientUserId: target.recipientUserId,
            startsAtUtc,
        });
        if (already) {
            return 'skipped';
        }

        const channel = await pickReminderChannel(
            deps,
            target.recipientUserId,
            input.customer,
        );

        const row = await deps.notificationService.dispatch({
            templateKey: target.templateKey,
            recipientUserId: target.recipientUserId,
            payload: {
                businessName: input.businessName,
                serviceName: input.serviceName,
                customerDisplayName: input.customerDisplayName,
                startsAtUtc,
            },
            channel,
        });

        if (row.status === 'SENT') {
            return 'sent';
        }
        // status === 'FAILED' (the dispatcher persisted a provider
        // failure). Booking flow already isolated; we just count it.
        scanLog.warn('Reminder landed as FAILED.', {
            appointmentId: appointment.id,
            templateKey: target.templateKey,
            recipientUserId: target.recipientUserId,
            notificationLogId: row.id,
            errorMessage: row.errorMessage,
        });
        return 'failed';
    } catch (err) {
        // Anything that escapes the dispatcher is an internal /
        // programming error (`UnknownTemplateKeyError`,
        // `NotificationRecipientNotFoundError`,
        // `NoGatewayForChannelError`, a `RepositoryError` from the
        // log insert). Log and continue.
        scanLog.warn('Reminder dispatch threw (swallowed).', {
            appointmentId: appointment.id,
            templateKey: target.templateKey,
            recipientUserId: target.recipientUserId,
            error: err instanceof Error ? err.message : String(err),
        });
        return 'failed';
    }
}

/**
 * Phase 9 Track 1 + Track 2 — channel selection for reminder
 * dispatch. Mirrors `AppointmentService.pickNotificationChannel`
 * priority order:
 *
 *   1. `'TELEGRAM'` when `telegramRoutingEnabled` AND recipient
 *      has a non-empty `telegram_chat_id`.
 *   2. `'SMS'` when `smsRoutingEnabled` AND recipient has a
 *      non-empty `phone`.
 *   3. `'MOCK'` otherwise.
 *
 * Short-circuits to `'MOCK'` without any DB call when BOTH
 * routing flags are false — preserves the pre-Phase-9 wire cost
 * for local-dev / unit-test paths.
 *
 * Lockstep contract with `notificationServiceFactory`: when the
 * handler enables a routing flag, the dispatcher always has the
 * corresponding gateway wired. The fallback to `MOCK` for
 * recipients without the matching field is harmless because
 * `MOCK` stays wired.
 */
async function pickReminderChannel(
    deps: ReminderBatchDeps,
    recipientUserId: string,
    preloadedCustomer: User | null,
): Promise<NotificationChannel> {
    const telegramOn = deps.telegramRoutingEnabled === true;
    const smsOn = deps.smsRoutingEnabled === true;
    if (!telegramOn && !smsOn) {
        return 'MOCK';
    }
    const recipient =
        preloadedCustomer && preloadedCustomer.id === recipientUserId
            ? preloadedCustomer
            : await deps.userRepo.findById(recipientUserId);
    if (!recipient) return 'MOCK';

    if (
        telegramOn &&
        typeof recipient.telegramChatId === 'string' &&
        recipient.telegramChatId.trim() !== ''
    ) {
        return 'TELEGRAM';
    }
    if (
        smsOn &&
        typeof recipient.phone === 'string' &&
        recipient.phone.trim() !== ''
    ) {
        return 'SMS';
    }
    return 'MOCK';
}
