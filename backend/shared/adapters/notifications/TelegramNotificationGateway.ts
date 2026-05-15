// EthioLink — Telegram notification gateway stub.
//
// MVP placeholder for the Telegram channel. The real
// implementation will use Telegram's Bot API (a single HTTP POST
// to `https://api.telegram.org/bot<TOKEN>/sendMessage`) once a
// production bot is registered and its token is loaded via the
// runtime config. Until then, every `send` throws
// `NotificationProviderNotConfiguredError` and the dispatcher
// records `notification_logs.status = 'FAILED'` with the error
// message — bookings continue regardless (notifications are
// best-effort by design).
//
// Same rationale as `SmsNotificationGateway` for throwing vs.
// returning `status: 'FAILED'`: this is a "not implemented",
// not a "carrier rejected", and the dispatcher's future retry
// logic should be able to tell them apart without parsing error
// messages.
//
// Future shape:
//   * The real gateway will accept `botToken` via the
//     constructor.
//   * `provider` will switch from the placeholder
//     `'TELEGRAM_STUB'` to `'TELEGRAM_BOT'` and that's what gets
//     written to `notification_logs.provider`.
//   * The class will validate that
//     `input.recipient.telegramChatId` is present before calling
//     the Bot API (chat IDs are numeric strings — Telegram
//     issues them when the user first messages the bot, which is
//     part of the customer-onboarding flow that lands alongside
//     the real gateway).

import type {
    NotificationGateway,
    NotificationSendInput,
    NotificationSendResult,
} from './NotificationGateway.js';
import { NotificationProviderNotConfiguredError } from './NotificationGateway.js';

const NOT_CONFIGURED_MESSAGE =
    'Telegram notifications are not yet configured. Notification will be marked FAILED.';

export class TelegramNotificationGateway implements NotificationGateway {
    public readonly channel = 'TELEGRAM' as const;
    /**
     * Placeholder provider identifier. When the real Bot API
     * integration ships, this becomes `'TELEGRAM_BOT'` and is
     * what gets persisted to `notification_logs.provider`.
     */
    public readonly provider = 'TELEGRAM_STUB' as const;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
    async send(_input: NotificationSendInput): Promise<NotificationSendResult> {
        throw new NotificationProviderNotConfiguredError(NOT_CONFIGURED_MESSAGE);
    }
}
