// EthioLink — recording fake for `SmsHttpTransport`.
//
// Used by `genericSmsGateway.test.ts` to script gateway responses
// without a network round-trip. Each test enqueues the response (or
// throw) it expects the gateway to encounter; the gateway's `send`
// call pops one entry per `post`.
//
// Captures every request in `calls` so tests can assert on:
//   * the URL the gateway built (verifies the `apiBaseUrl` +
//     `/v1/send` concatenation).
//   * the headers (auth, content-type).
//   * the body (recipient phone, sender id, message, idempotency
//     key forwarding).
//
// Mirrors the recording-fake pattern of `FakeStorageGateway`.

import type {
    SmsHttpRequestOptions,
    SmsHttpResponse,
    SmsHttpTransport,
} from '../../shared/adapters/notifications/GenericSmsGateway.js';

/**
 * Scripted outcome for one `post` call. Exactly one of
 * `status`/`body` or `throws` should be set. When `throws` is
 * absent, `status` defaults to 200 and `body` to `null`.
 */
export interface ScriptedSmsResponse {
    /** HTTP status code the transport returns. Ignored when `throws` is set. */
    readonly status?: number;
    /** Parsed body the transport returns. Ignored when `throws` is set. */
    readonly body?: unknown;
    /** When set, the transport throws this error instead of returning a response. */
    readonly throws?: Error;
}

/** Captured request for assertion. */
export interface CapturedSmsRequest {
    readonly url: string;
    readonly options: SmsHttpRequestOptions;
}

export class FakeSmsHttpTransport implements SmsHttpTransport {
    public readonly calls: CapturedSmsRequest[] = [];
    private readonly responses: ScriptedSmsResponse[] = [];

    /** Queue a scripted response. FIFO. */
    enqueue(response: ScriptedSmsResponse): void {
        this.responses.push(response);
    }

    /** Most recent captured request, or `undefined` if not called. */
    lastCall(): CapturedSmsRequest | undefined {
        return this.calls[this.calls.length - 1];
    }

    /** Reset between subtests. */
    reset(): void {
        this.calls.length = 0;
        this.responses.length = 0;
    }

    async post(
        url: string,
        options: SmsHttpRequestOptions,
    ): Promise<SmsHttpResponse> {
        this.calls.push(
            Object.freeze<CapturedSmsRequest>({
                url,
                options: Object.freeze({ ...options }),
            }),
        );

        const next = this.responses.shift();
        if (!next) {
            throw new Error(
                'FakeSmsHttpTransport: post called but no scripted response remaining.',
            );
        }
        if (next.throws) {
            throw next.throws;
        }
        return Object.freeze<SmsHttpResponse>({
            status: next.status ?? 200,
            body: next.body ?? null,
        });
    }
}
