// EthioLink — mock notification gateway.
//
// MVP's default `NotificationGateway`. Used whenever no real
// provider is configured for the requested channel — which, in
// MVP, is every channel. The mock always succeeds: every `send`
// returns `status: 'SENT'` with a synthetic `providerRef` so the
// dispatcher exercises the happy path end-to-end without hitting
// a real upstream.
//
// Why a successful no-op rather than a typed error like the
// payments `MockOnlineGateway`:
//   * Bookings cannot proceed without payment authorization, so
//     "online payments unavailable" is a hard rejection at the
//     boundary.
//   * Notifications are best-effort by design — the booking flow
//     succeeds whether or not the customer's SMS lands. Treating
//     the mock as a successful sink is the most useful posture
//     for local dev, integration tests, and the AWS-hosted dev
//     environment before real providers are wired up.
//   * Admins inspecting `notification_logs` will see
//     `provider = 'MOCK'` + a `mock-<uuid>` reference, which is
//     unambiguous: nothing actually went out over the wire.
//
// Design notes:
//   * `providerRef` is `mock-<uuid>` (Node's `crypto.randomUUID`).
//     Stable enough to query, prefixed so an admin can tell at a
//     glance that the row didn't hit a real provider.
//   * `rawResponse` is a small object echoing the recipient + a
//     `mocked: true` flag. The dispatcher persists this verbatim
//     to `notification_logs.payload`'s sibling debugging surface
//     (the future admin endpoint renders it as `<pre>`).
//   * `sentAt` uses `new Date().toISOString()`. The clock is the
//     only side effect; sufficient for an MVP that doesn't need
//     an injected clock here. Tests assert the ISO format, not
//     the value.
//   * `idempotencyKey` is accepted but ignored — there's no
//     upstream to dedupe against.

import { randomUUID } from 'node:crypto';

import type {
    NotificationGateway,
    NotificationSendInput,
    NotificationSendResult,
} from './NotificationGateway.js';

export class MockNotificationGateway implements NotificationGateway {
    public readonly channel = 'MOCK' as const;
    public readonly provider = 'MOCK' as const;

    async send(input: NotificationSendInput): Promise<NotificationSendResult> {
        const providerRef = `mock-${randomUUID()}`;
        return Object.freeze<NotificationSendResult>({
            status: 'SENT',
            provider: this.provider,
            providerRef,
            rawResponse: {
                mocked: true,
                channel: input.channel,
                recipient: { ...input.recipient },
                bodyPreview: input.rendered.body.slice(0, 120),
            },
            errorCode: null,
            errorMessage: null,
            sentAt: new Date().toISOString(),
        });
    }
}
