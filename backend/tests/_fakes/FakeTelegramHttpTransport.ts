// EthioLink — recording fake for `TelegramHttpTransport`.
//
// Used by `genericTelegramGateway.test.ts`. Same shape as
// `FakeSmsHttpTransport`: tests enqueue scripted responses (or
// throws) and assert on captured request shape via `calls`.

import type {
    TelegramHttpRequestOptions,
    TelegramHttpResponse,
    TelegramHttpTransport,
} from '../../shared/adapters/notifications/GenericTelegramGateway.js';

export interface ScriptedTelegramResponse {
    readonly status?: number;
    readonly body?: unknown;
    readonly throws?: Error;
}

export interface CapturedTelegramRequest {
    readonly url: string;
    readonly options: TelegramHttpRequestOptions;
}

export class FakeTelegramHttpTransport implements TelegramHttpTransport {
    public readonly calls: CapturedTelegramRequest[] = [];
    private readonly responses: ScriptedTelegramResponse[] = [];

    enqueue(response: ScriptedTelegramResponse): void {
        this.responses.push(response);
    }

    lastCall(): CapturedTelegramRequest | undefined {
        return this.calls[this.calls.length - 1];
    }

    reset(): void {
        this.calls.length = 0;
        this.responses.length = 0;
    }

    async post(
        url: string,
        options: TelegramHttpRequestOptions,
    ): Promise<TelegramHttpResponse> {
        this.calls.push(
            Object.freeze<CapturedTelegramRequest>({
                url,
                options: Object.freeze({ ...options }),
            }),
        );

        const next = this.responses.shift();
        if (!next) {
            throw new Error(
                'FakeTelegramHttpTransport: post called but no scripted response remaining.',
            );
        }
        if (next.throws) {
            throw next.throws;
        }
        return Object.freeze<TelegramHttpResponse>({
            status: next.status ?? 200,
            body: next.body ?? null,
        });
    }
}
