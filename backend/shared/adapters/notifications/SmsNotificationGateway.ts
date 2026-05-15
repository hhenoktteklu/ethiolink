// EthioLink — SMS notification gateway stub.
//
// MVP placeholder for the SMS channel. Real Ethiopian SMS gateway
// integration (Ethio Telecom, AfroMessage, Twilio with international
// fallback) is post-MVP and will each ship as its own
// `NotificationGateway` implementation behind this same port —
// likely with the class names `EthioTelecomSmsGateway`,
// `AfroMessageSmsGateway`, etc. Until then, every `send` throws
// `NotificationProviderNotConfiguredError` so the dispatcher writes
// `notification_logs.status = 'FAILED'` with a clear error message
// and the booking flow continues uninterrupted.
//
// Why throw instead of returning `status: 'FAILED'`:
//   * `FAILED` means "the provider tried and the carrier refused"
//     — a transient business outcome. The dispatcher persists the
//     row and (in a future commit) might retry.
//   * `NotificationProviderNotConfiguredError` means "this channel
//     is not implemented" — a deployment-level configuration gap.
//     The dispatcher persists the failure once and never retries.
//     The error class makes the two cases unambiguously
//     distinguishable so a future retry job can ignore the latter.
//
// Future shape:
//   * The real gateway will accept `apiKey` + `senderId` (and
//     possibly a `apiBase` for sandbox vs. production) via the
//     constructor.
//   * `provider` will switch from the placeholder `'SMS_STUB'` to
//     the concrete provider name (e.g. `'ETHIO_TELECOM_SMS'`),
//     which is also what gets written to
//     `notification_logs.provider`.
//   * The class will validate that `input.recipient.phoneE164` is
//     present and well-formed before calling the upstream.

import type {
    NotificationGateway,
    NotificationSendInput,
    NotificationSendResult,
} from './NotificationGateway.js';
import { NotificationProviderNotConfiguredError } from './NotificationGateway.js';

const NOT_CONFIGURED_MESSAGE =
    'SMS notifications are not yet configured. Notification will be marked FAILED.';

export class SmsNotificationGateway implements NotificationGateway {
    public readonly channel = 'SMS' as const;
    /**
     * Placeholder provider identifier. When a real SMS provider
     * ships, this becomes the concrete vendor name (and a new
     * class is added — this stub may stay around as a config-
     * toggled "force-fail" gateway, or be deleted).
     */
    public readonly provider = 'SMS_STUB' as const;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
    async send(_input: NotificationSendInput): Promise<NotificationSendResult> {
        throw new NotificationProviderNotConfiguredError(NOT_CONFIGURED_MESSAGE);
    }
}
