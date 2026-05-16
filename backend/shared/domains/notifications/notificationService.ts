// EthioLink — notification dispatcher service.
//
// Single entry point for sending an EthioLink-side notification.
// Composes:
//
//   * `UserRepository`         — resolve the recipient (we need
//                                their phone / email / Telegram
//                                chat id for the gateway, even
//                                though the mock ignores them).
//   * `NotificationLogRepository` — persist the QUEUED row, then
//                                update to SENT / FAILED.
//   * `NotificationGateway` per channel — actually ship the
//                                rendered message. The dispatcher
//                                is constructed with a map from
//                                channel → gateway; channels with
//                                no configured gateway raise
//                                `NoGatewayForChannelError` (a
//                                programming error, not a
//                                transient failure).
//   * `renderTemplate`         — turn the booking payload into a
//                                channel-neutral
//                                `NotificationRenderedMessage`.
//
// Public surface: a single `dispatch(input)` method. Booking
// handlers (next commit) call this once per recipient per event.
// The dispatcher fans out per-template, not per-event — the
// booking handler picks which template(s) apply (e.g. an ACCEPT
// fires `booking.accepted.customer`).
//
// Lifecycle per call (matches PHASE_6_NOTIFICATIONS.md):
//
//   1. **Resolve recipient.** `userRepository.findById(recipientUserId)`.
//      `null` → `NotificationRecipientNotFoundError` (the caller
//      passed a stale id; surface so tests catch it; do not write
//      a log row because we don't even have a confirmed
//      `recipient_user_id` constraint target).
//
//   2. **Render template.** `renderTemplate(templateKey, payload)`.
//      An unknown key throws `UnknownTemplateKeyError` — same
//      posture: a programming error, surface, don't log.
//
//   3. **Insert QUEUED log.** `notificationLogRepository.insert`
//      writes the row at the DB-default `status = 'QUEUED'`. We
//      pass the raw `payload` (not the rendered body) so the
//      admin's debug view shows the structured inputs — the
//      rendered body is cheap to regenerate and would just be
//      noise in the JSONB column.
//
//   4. **Call `gateway.send`.** The gateway is looked up by
//      channel. A missing entry in the map is
//      `NoGatewayForChannelError` (programming error). A
//      `NotificationGatewayError` (provider not configured, or
//      generic infra failure) is CAUGHT — it is the same posture
//      as a `status: 'FAILED'` result from a real provider that
//      just rejected the send. Both paths update the log to
//      `FAILED` with `error_message` and return normally so the
//      booking flow continues. *Notifications are best-effort;
//      they must never break a booking.* (See
//      PHASE_6_NOTIFICATIONS.md "Acceptance criteria".)
//
//   5. **Update log to SENT / FAILED.** Single
//      `updateStatus(id, { status, providerRef, errorMessage })`
//      call with the full transition shape.
//
//   6. **Return the final `NotificationLogRow`.** Useful for
//      tests and any future "did this go out?" path. The booking
//      handler ignores it.
//
// Channel selection:
//
//   * The dispatcher defaults to `MOCK` when the caller doesn't
//     specify one. That keeps the MVP wiring trivial: every
//     booking event lands on `MockNotificationGateway` until a
//     real provider is configured.
//   * Callers MAY override with `channel: 'SMS' | 'TELEGRAM' |
//     'EMAIL' | 'PUSH'`. With no real gateway configured, the
//     stub gateway throws `NotificationProviderNotConfiguredError`,
//     which the dispatcher persists as `FAILED` and swallows.
//     This is the right MVP posture: the lifecycle works
//     end-to-end and the admin can see in the notification log
//     which channels are unconfigured.
//
// Logger:
//
//   * Each `dispatch` call gets a `child({ component:
//     'notificationService', notificationLogId })` logger so the
//     QUEUED-row id is on every line. The dispatcher logs at
//     `info` for SENT, `warn` for FAILED (provider-rejected),
//     and `error` for the programming-error branches before they
//     throw.

import type { Logger } from '../../logging/logger.js';
import type { UserRepository } from '../users/userRepository.js';

import type {
    NotificationChannel,
    NotificationGateway,
    NotificationRecipient,
    NotificationSendInput,
    NotificationSendResult,
} from '../../adapters/notifications/NotificationGateway.js';
import { NotificationGatewayError } from '../../adapters/notifications/NotificationGateway.js';
import type {
    NotificationLogRepository,
    NotificationLogRow,
} from './notificationLogRepository.js';

import type { BookingTemplatePayload } from './templateRegistry.js';
import { UnknownTemplateKeyError, renderTemplate } from './templateRegistry.js';

// Re-export so callers (booking handlers + tests) can import the
// dispatcher-relevant error types from one module.
export { UnknownTemplateKeyError };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Raised when `dispatch` is asked to send to a `recipientUserId`
 * that no longer exists. Programming error at the call site —
 * the booking handler should pass an id it just read from a
 * confirmed FK. Surfaced (not swallowed) so tests catch stale
 * ids; no `notification_logs` row is written.
 */
export class NotificationRecipientNotFoundError extends Error {
    public readonly recipientUserId: string;

    constructor(recipientUserId: string) {
        super(`Notification recipient ${recipientUserId} not found.`);
        this.name = 'NotificationRecipientNotFoundError';
        this.recipientUserId = recipientUserId;
    }
}

/**
 * Raised when `dispatch` is asked to use a channel for which the
 * service has no gateway configured. Programming error — the
 * server boot wiring should always register a gateway for every
 * channel the call sites use (at minimum `MOCK`).
 */
export class NoGatewayForChannelError extends Error {
    public readonly channel: NotificationChannel;

    constructor(channel: NotificationChannel) {
        super(`No notification gateway configured for channel: ${channel}.`);
        this.name = 'NoGatewayForChannelError';
        this.channel = channel;
    }
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * Input accepted by `NotificationService.dispatch`. Most fields
 * mirror the booking-event context the caller already has on
 * hand; the dispatcher is intentionally narrow — it doesn't
 * accept arbitrary "send anything" inputs.
 */
export interface DispatchNotificationInput {
    /** Template key from {@link BookingTemplateKey}. Free-form
     *  `string` here for the same reason
     *  `notification_logs.template_key` is — keeps the dispatcher
     *  open to additive growth. Unknown keys raise
     *  `UnknownTemplateKeyError` at render time. */
    readonly templateKey: string;

    /** UUID of the user who should receive the notification. */
    readonly recipientUserId: string;

    /** Structured template payload. Same shape for every booking
     *  template — see `templateRegistry.ts`. */
    readonly payload: BookingTemplatePayload;

    /** Channel to ship through. Defaults to `'MOCK'` so the MVP
     *  wiring is trivial. */
    readonly channel?: NotificationChannel;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface NotificationServiceDeps {
    readonly notificationLogRepository: NotificationLogRepository;
    readonly userRepository: UserRepository;
    /**
     * Map from `NotificationChannel` to its configured gateway
     * instance. The MVP wiring registers `MockNotificationGateway`
     * under `'MOCK'` (and optionally the SMS / Telegram stubs
     * under their channels — they throw on every `send`, which
     * the dispatcher persists as `FAILED`).
     *
     * Using a `Record` instead of a `Map` keeps it serialisable
     * for any future config snapshot and lets the dispatcher
     * iterate the keys at boot if it ever wants to.
     */
    readonly gateways: Readonly<Partial<Record<NotificationChannel, NotificationGateway>>>;
    readonly logger: Logger;
}

export class NotificationService {
    private readonly notificationLogRepository: NotificationLogRepository;
    private readonly userRepository: UserRepository;
    private readonly gateways: Readonly<
        Partial<Record<NotificationChannel, NotificationGateway>>
    >;
    private readonly logger: Logger;

    constructor(deps: NotificationServiceDeps) {
        this.notificationLogRepository = deps.notificationLogRepository;
        this.userRepository = deps.userRepository;
        this.gateways = deps.gateways;
        this.logger = deps.logger.child({ component: 'notificationService' });
    }

    /**
     * Dispatch a single notification.
     *
     * Returns the final `NotificationLogRow` (SENT or FAILED).
     * Provider failures are NOT thrown — they are persisted as
     * `FAILED` and the row is returned normally. Internal errors
     * (`UnknownTemplateKeyError`, `NotificationRecipientNotFoundError`,
     * `NoGatewayForChannelError`) ARE thrown — they indicate a
     * bug at the call site.
     */
    async dispatch(input: DispatchNotificationInput): Promise<NotificationLogRow> {
        const channel: NotificationChannel = input.channel ?? 'MOCK';

        // (1) Resolve recipient.
        const user = await this.userRepository.findById(input.recipientUserId);
        if (!user) {
            this.logger.error('Notification recipient not found.', {
                recipientUserId: input.recipientUserId,
                templateKey: input.templateKey,
            });
            throw new NotificationRecipientNotFoundError(input.recipientUserId);
        }

        // (2) Render template. UnknownTemplateKeyError surfaces.
        const rendered = renderTemplate(input.templateKey, input.payload);

        // (3) Look up gateway BEFORE inserting the log row, so a
        //     missing gateway doesn't litter `notification_logs`
        //     with QUEUED rows that can never transition.
        const gateway = this.gateways[channel];
        if (!gateway) {
            this.logger.error('No notification gateway configured for channel.', {
                channel,
                templateKey: input.templateKey,
            });
            throw new NoGatewayForChannelError(channel);
        }

        // (4) Insert QUEUED log. We persist the structured payload
        //     (not the rendered body) because the registry can
        //     re-render at any time and the JSONB stays useful for
        //     debugging.
        const queuedRow = await this.notificationLogRepository.insert({
            recipientUserId: user.id,
            channel,
            templateKey: input.templateKey,
            payload: { ...input.payload },
            provider: gateway.provider,
        });

        const stepLog = this.logger.child({
            notificationLogId: queuedRow.id,
            channel,
            templateKey: input.templateKey,
            provider: gateway.provider,
        });

        // (5) Call gateway.send. Provider errors are CAUGHT and
        //     translated into a FAILED log update.
        let sendResult: NotificationSendResult | null = null;
        let providerError: NotificationGatewayError | null = null;
        try {
            const sendInput: NotificationSendInput = {
                channel,
                recipient: buildRecipient(user),
                rendered,
                idempotencyKey: queuedRow.id,
            };
            sendResult = await gateway.send(sendInput);
        } catch (err) {
            // Provider-class errors are the swallow path. Anything
            // else is unexpected — re-throw it after attempting to
            // mark the log FAILED so the admin can see something
            // went wrong without losing the error.
            if (err instanceof NotificationGatewayError) {
                providerError = err;
            } else {
                stepLog.error('Notification gateway threw an unexpected error.', {
                    error: err instanceof Error ? err.message : String(err),
                });
                // Best-effort mark as FAILED, then re-throw.
                await this.safeMarkFailed(queuedRow.id, null, errorMessageOf(err));
                throw err;
            }
        }

        // (6) Update log to SENT / FAILED.
        const finalRow = await this.applyResult(
            queuedRow.id,
            sendResult,
            providerError,
            stepLog,
        );

        return finalRow;
    }

    // -----------------------------------------------------------------------
    // Internals
    // -----------------------------------------------------------------------

    private async applyResult(
        notificationLogId: string,
        result: NotificationSendResult | null,
        providerError: NotificationGatewayError | null,
        stepLog: Logger,
    ): Promise<NotificationLogRow> {
        if (result && result.status === 'SENT') {
            const row = await this.notificationLogRepository.updateStatus(
                notificationLogId,
                {
                    status: 'SENT',
                    providerRef: result.providerRef,
                    errorMessage: null,
                },
            );
            stepLog.info('Notification sent.', { providerRef: result.providerRef });
            return row;
        }

        // Either the provider returned FAILED (declined / rejected)
        // or it threw a NotificationGatewayError (not configured,
        // misconfigured, infra). Same persisted outcome.
        const providerRef = result?.providerRef ?? null;
        const errorMessage = result?.errorMessage ?? providerError?.message ?? 'Unknown notification failure.';

        const row = await this.notificationLogRepository.updateStatus(notificationLogId, {
            status: 'FAILED',
            providerRef,
            errorMessage,
        });

        stepLog.warn('Notification failed.', {
            errorCode: result?.errorCode ?? providerError?.code ?? null,
            errorMessage,
        });
        return row;
    }

    /**
     * Best-effort FAILED-mark used when the gateway threw an
     * unexpected (non-`NotificationGatewayError`) error. If this
     * UPDATE itself fails, log and move on — the original error
     * will still be re-thrown by the caller.
     */
    private async safeMarkFailed(
        notificationLogId: string,
        providerRef: string | null,
        errorMessage: string,
    ): Promise<void> {
        try {
            await this.notificationLogRepository.updateStatus(notificationLogId, {
                status: 'FAILED',
                providerRef,
                errorMessage,
            });
        } catch (err) {
            this.logger.error('Failed to mark notification log as FAILED after unexpected gateway error.', {
                notificationLogId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the routing fields the gateway needs from a resolved
 * `users` row. The mock ignores all of them; real providers pick
 * the field for their channel.
 */
function buildRecipient(user: {
    id: string;
    email: string | null;
    phone: string | null;
    telegramChatId: string | null;
}): NotificationRecipient {
    return {
        userId: user.id,
        phoneE164: user.phone ?? undefined,
        emailAddress: user.email ?? undefined,
        // Phase 9 Track 2: `users.telegram_chat_id` (migration 0014)
        // is read here so the (future) Telegram gateway sees the
        // linked chat id when the user has opted in. Un-linked
        // users get `undefined` and the Telegram gateway throws
        // `TELEGRAM_RECIPIENT_MISSING` — the dispatcher persists
        // `FAILED` and the dispatcher's channel selector (future
        // commit) avoids routing `TELEGRAM` to un-linked users in
        // the first place.
        telegramChatId: user.telegramChatId ?? undefined,
    };
}

function errorMessageOf(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}
