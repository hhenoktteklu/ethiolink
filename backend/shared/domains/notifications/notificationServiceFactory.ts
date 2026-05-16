// EthioLink — NotificationService factory.
//
// Phase 9 commit on the "real SMS provider" track. Centralizes the
// previously-duplicated `NotificationService` construction across
// every appointment handler + the scheduled reminder handler. The
// duplication was uniform (every site wired the same
// `{ MOCK: new MockNotificationGateway() }` map), so the factory
// is a pure refactor at the call sites — same behavior, fewer
// lines.
//
// The factory's value-add is the conditional SMS wiring:
//
//   * Always wires `MOCK` → `MockNotificationGateway`. That's
//     the safe default; even when SMS is configured, callers that
//     dispatch with `channel: 'MOCK'` (every booking handler does
//     today — see `appointmentService.notify`) continue to hit the
//     mock. No production traffic flips with this commit alone.
//
//   * Wires `SMS` → `GenericSmsGateway` only when BOTH:
//       1. `config.smsProvider` is non-null (operator has set the
//          required env vars).
//       2. `config.notificationsProvider` is `'sms'` or
//          `'production'` (operator has explicitly opted in via
//          the `NOTIFICATIONS_PROVIDER` env var).
//     If either condition is false, the `SMS` channel is left
//     unmapped — a `dispatch({ channel: 'SMS', ... })` call would
//     raise `NoGatewayForChannelError` (caught by the dispatcher,
//     persisted as `FAILED` in `notification_logs`). Booking flow
//     remains unaffected because `swallowNotifyError` catches
//     everything in the dispatch path.
//
// Provider-error semantics (carried over from
// `GenericSmsGateway` + `NotificationService.dispatch`):
//
//   * 4xx provider rejection → `notification_logs.status = 'FAILED'`
//     with `errorCode = 'SMS_PROVIDER_REJECTED'`. No throw.
//   * 5xx provider outage / timeout → throws
//     `SmsProviderUnavailableError`; dispatcher catches and writes
//     `FAILED` with `errorCode = 'SMS_PROVIDER_UNAVAILABLE'`.
//   * Either way the booking handler's `swallowNotifyError` keeps
//     the booking flow intact.
//
// Future routing change (NOT this commit):
//   Flipping production traffic to SMS requires changing the
//   default channel `appointmentService.notify` passes when
//   recipient.phone is available. That's a separate, behavior-
//   shifting commit. This factory only makes the gateway
//   *available* — the dispatch-side routing decision is held back.

import type { Pool } from 'pg';

import {
    createGenericSmsGateway,
    type SmsHttpTransport,
} from '../../adapters/notifications/GenericSmsGateway.js';
import {
    createGenericTelegramGateway,
    type TelegramHttpTransport,
} from '../../adapters/notifications/GenericTelegramGateway.js';
import { MockNotificationGateway } from '../../adapters/notifications/MockNotificationGateway.js';
import type {
    NotificationChannel,
    NotificationGateway,
} from '../../adapters/notifications/NotificationGateway.js';
import type { AppConfig } from '../../config/loadConfig.js';
import type { Logger } from '../../logging/logger.js';

import { PgNotificationLogRepository } from './notificationLogRepository.js';
import { NotificationService } from './notificationService.js';
import { PgUserRepository } from '../users/userRepository.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CreateNotificationServiceDeps {
    /** Connection pool used by both `PgUserRepository` and `PgNotificationLogRepository`. */
    readonly pool: Pool;
    /** Resolved config — drives the gateway-selection branch. */
    readonly config: AppConfig;
    /** Logger; the service appends its own `component` child tag. */
    readonly logger: Logger;
    /**
     * Optional transport injection for tests. Production code
     * should pass nothing (the gateway uses
     * `defaultFetchSmsHttpTransport()` internally).
     */
    readonly smsHttpTransport?: SmsHttpTransport;
    /**
     * Optional Telegram transport injection for tests. Production
     * passes nothing (uses `defaultFetchTelegramHttpTransport()`).
     */
    readonly telegramHttpTransport?: TelegramHttpTransport;
    /**
     * Optional mock gateway override. Tests may pass a stub to
     * assert the right gateway was constructed.
     */
    readonly mockGateway?: NotificationGateway;
}

/**
 * Build a `NotificationService` wired with the right gateways for
 * the current `AppConfig`. See module header for the selection
 * logic. The returned service is functionally identical to the
 * hand-built version every appointment handler used pre-Phase-9.
 */
export function createNotificationService(
    deps: CreateNotificationServiceDeps,
): NotificationService {
    return new NotificationService({
        userRepository: new PgUserRepository(deps.pool),
        notificationLogRepository: new PgNotificationLogRepository(deps.pool),
        gateways: buildGatewayMap(deps),
        logger: deps.logger,
    });
}

// ---------------------------------------------------------------------------
// Gateway selection
// ---------------------------------------------------------------------------

/**
 * Compute the `channel → gateway` map for the current config.
 * Exported for unit testing — production callers should use
 * {@link createNotificationService}.
 *
 * Order of evaluation:
 *   1. `MOCK` is always wired. Safe default.
 *   2. `SMS` is wired iff `smsProvider` is non-null AND
 *      `notificationsProvider` is one of `'sms'` or `'production'`.
 *   3. `TELEGRAM` is wired iff `telegramProvider` is non-null AND
 *      `notificationsProvider` is one of `'telegram'` or
 *      `'production'`. Independent from SMS — operators can opt
 *      into either, both, or neither.
 */
export function buildGatewayMap(
    deps: CreateNotificationServiceDeps,
): Partial<Record<NotificationChannel, NotificationGateway>> {
    const map: Partial<Record<NotificationChannel, NotificationGateway>> = {
        MOCK: deps.mockGateway ?? new MockNotificationGateway(),
    };

    if (shouldWireSmsGateway(deps.config)) {
        map.SMS = createGenericSmsGateway(
            deps.config.smsProvider,
            deps.smsHttpTransport,
        );
    }

    if (shouldWireTelegramGateway(deps.config)) {
        map.TELEGRAM = createGenericTelegramGateway(
            deps.config.telegramProvider,
            deps.telegramHttpTransport,
        );
    }

    return map;
}

/**
 * Returns true when the operator has opted in to the real SMS
 * gateway via BOTH the env-driven provider flag and the per-vendor
 * config block. Exported for tests.
 */
export function shouldWireSmsGateway(config: AppConfig): boolean {
    if (!config.smsProvider) return false;
    return (
        config.notificationsProvider === 'sms' ||
        config.notificationsProvider === 'production'
    );
}

/**
 * Returns true when the operator has opted in to the real
 * Telegram gateway via BOTH `telegramProvider` config AND the
 * provider flag (`'telegram'` or `'production'`). The handler-side
 * derivation `telegramRoutingEnabled` mirrors this — see the
 * docstrings on `AppointmentServiceOptions.telegramRoutingEnabled`
 * and `ReminderBatchDeps.telegramRoutingEnabled`.
 */
export function shouldWireTelegramGateway(config: AppConfig): boolean {
    if (!config.telegramProvider) return false;
    return (
        config.notificationsProvider === 'telegram' ||
        config.notificationsProvider === 'production'
    );
}
