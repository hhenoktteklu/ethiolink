// EthioLink — Telegram Lambda handler tests.
//
// Covers the four endpoints introduced in the Phase 9 commit
// "add Telegram link endpoints":
//
//   * `POST /v1/me/link-telegram/start`
//   * `GET  /v1/me/telegram-status`
//   * `DELETE /v1/me/link-telegram`
//   * `POST /v1/integrations/telegram/webhook`
//
// The handlers expose pure `handleX(deps, event)` functions so
// the tests can inject in-memory fakes for every dependency and
// drive the branches without booting `loadSecretsThenConfig` or
// the AWS SDK.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
    APIGatewayProxyEvent,
    APIGatewayProxyEventHeaders,
} from 'aws-lambda';

import {
    AuthError,
    type AuthPrincipal,
    type AuthProvider,
} from '../../shared/adapters/auth/AuthProvider.js';
import { TelegramLinkService } from '../../shared/domains/users/telegramLinkService.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { handleStart } from '../../lambdas/me/linkTelegramStart.js';
import { handleStatus } from '../../lambdas/me/linkTelegramStatus.js';
import { handleUnlink } from '../../lambdas/me/linkTelegramUnlink.js';
import { handleWebhook } from '../../lambdas/integrations/telegramWebhook.js';
import { createLogger } from '../../shared/logging/logger.js';
import { InMemoryTelegramLinkCodeRepository } from '../_fakes/InMemoryTelegramLinkCodeRepository.js';
import { InMemoryUserRepository } from '../_fakes/InMemoryUserRepository.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function silentLogger() {
    return createLogger({
        level: 'error',
        sink: { write: () => {} },
    });
}

const BOT_USERNAME = 'EthioLinkBot';
const LINK_TTL_SECONDS = 600;

interface AuthSetup {
    readonly principal: AuthPrincipal;
    readonly provider: AuthProvider;
}

/**
 * Auth-provider fake. Always returns the supplied principal from
 * `principalFromClaims` (the API-Gateway path) and from
 * `verifyToken` (the bearer-fallback path). The
 * `failingProvider` variant throws `AuthError` to drive the
 * 401 branch.
 */
function authProviderFor(sub: string): AuthSetup {
    const principal: AuthPrincipal = Object.freeze({
        sub,
        email: null,
        phone: null,
        displayName: null,
        groups: [],
        role: 'CUSTOMER',
    });
    return {
        principal,
        provider: {
            async verifyToken() {
                return principal;
            },
            principalFromClaims() {
                return principal;
            },
        },
    };
}

function failingAuthProvider(): AuthProvider {
    return {
        async verifyToken() {
            throw new AuthError('No authentication credentials in request.');
        },
        principalFromClaims() {
            throw new AuthError('No authentication credentials in request.');
        },
    };
}

/**
 * Synthesise an API Gateway event with a pre-validated authorizer
 * claim. The `extractPrincipal` helper reads `authorizer.claims`
 * first, so this is the path we exercise.
 */
function eventWithClaims(
    sub: string,
    overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
    return {
        body: null,
        headers: {},
        multiValueHeaders: {},
        httpMethod: 'POST',
        isBase64Encoded: false,
        path: '/',
        pathParameters: null,
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        stageVariables: null,
        resource: '/',
        requestContext: {
            accountId: 'acc',
            apiId: 'api',
            authorizer: { claims: { sub } },
            httpMethod: 'POST',
            identity: {} as never,
            path: '/',
            protocol: 'HTTP/1.1',
            requestId: 'req-test',
            requestTimeEpoch: 0,
            resourceId: 'res',
            resourcePath: '/',
            stage: 'test',
        } as never,
        ...overrides,
    };
}

function anonymousEvent(
    overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
    return eventWithClaims('unused', {
        ...overrides,
        requestContext: {
            ...(eventWithClaims('x').requestContext as Record<string, unknown>),
            authorizer: undefined,
        } as never,
    });
}

async function seedUser(users: InMemoryUserRepository, sub = 'sub-1') {
    return users.upsertFromAuth({
        cognitoSub: sub,
        email: 'owner@example.com',
        phone: null,
        role: 'BUSINESS_OWNER',
        displayName: 'Selam Tadesse',
    });
}

function buildLinkService(
    users: InMemoryUserRepository,
    codes: InMemoryTelegramLinkCodeRepository,
    codeGenerator: () => string = () => 'STATIC-CODE',
): TelegramLinkService {
    return new TelegramLinkService({
        userRepo: users,
        linkCodeRepo: codes,
        config: {
            botUsername: BOT_USERNAME,
            linkCodeTtlSeconds: LINK_TTL_SECONDS,
        },
        logger: silentLogger(),
        codeGenerator,
    });
}

// ---------------------------------------------------------------------------
// linkTelegramStart
// ---------------------------------------------------------------------------

describe('handleStart — POST /v1/me/link-telegram/start', () => {
    it('issues a deep link + expiry for an authenticated caller', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const { provider } = authProviderFor(user.cognitoSub);
        const linkService = buildLinkService(users, codes);

        const res = await handleStart(
            {
                authProvider: provider,
                userService: new UserService(users, silentLogger()),
                linkService,
                logger: silentLogger(),
            },
            eventWithClaims(user.cognitoSub),
        );

        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body) as {
            deepLink: string;
            expiresAt: string;
        };
        assert.strictEqual(
            body.deepLink,
            `https://t.me/${BOT_USERNAME}?start=STATIC-CODE`,
        );
        assert.match(
            body.expiresAt,
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
    });

    it('returns 401 when no auth credentials are present', async () => {
        const res = await handleStart(
            {
                authProvider: failingAuthProvider(),
                userService: new UserService(
                    new InMemoryUserRepository(),
                    silentLogger(),
                ),
                linkService: buildLinkService(
                    new InMemoryUserRepository(),
                    new InMemoryTelegramLinkCodeRepository(),
                ),
                logger: silentLogger(),
            },
            anonymousEvent(),
        );
        assert.strictEqual(res.statusCode, 401);
    });

    it('returns 404 when the user row does not exist yet', async () => {
        const users = new InMemoryUserRepository();
        const { provider } = authProviderFor('unknown-sub');
        const res = await handleStart(
            {
                authProvider: provider,
                userService: new UserService(users, silentLogger()),
                linkService: buildLinkService(
                    users,
                    new InMemoryTelegramLinkCodeRepository(),
                ),
                logger: silentLogger(),
            },
            eventWithClaims('unknown-sub'),
        );
        assert.strictEqual(res.statusCode, 404);
    });

    it('returns 503 when Telegram is not configured in this env', async () => {
        const users = new InMemoryUserRepository();
        const user = await seedUser(users);
        const { provider } = authProviderFor(user.cognitoSub);

        const res = await handleStart(
            {
                authProvider: provider,
                userService: new UserService(users, silentLogger()),
                linkService: null,
                logger: silentLogger(),
            },
            eventWithClaims(user.cognitoSub),
        );
        assert.strictEqual(res.statusCode, 503);
    });
});

// ---------------------------------------------------------------------------
// linkTelegramStatus
// ---------------------------------------------------------------------------

describe('handleStatus — GET /v1/me/telegram-status', () => {
    it('returns linked=false when no chat id is set', async () => {
        const users = new InMemoryUserRepository();
        const user = await seedUser(users);
        const { provider } = authProviderFor(user.cognitoSub);

        const res = await handleStatus(
            {
                authProvider: provider,
                userService: new UserService(users, silentLogger()),
                logger: silentLogger(),
            },
            eventWithClaims(user.cognitoSub),
        );
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body) as {
            linked: boolean;
            linkedAt: string | null;
        };
        assert.deepStrictEqual(body, { linked: false, linkedAt: null });
    });

    it('returns linked=true + linkedAt when a chat id is set', async () => {
        const users = new InMemoryUserRepository();
        const user = await seedUser(users);
        await users.setTelegramChatId(user.id, '987654321');

        const { provider } = authProviderFor(user.cognitoSub);
        const res = await handleStatus(
            {
                authProvider: provider,
                userService: new UserService(users, silentLogger()),
                logger: silentLogger(),
            },
            eventWithClaims(user.cognitoSub),
        );
        assert.strictEqual(res.statusCode, 200);
        const body = JSON.parse(res.body) as {
            linked: boolean;
            linkedAt: string | null;
        };
        assert.strictEqual(body.linked, true);
        assert.match(
            body.linkedAt ?? '',
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
        );
    });
});

// ---------------------------------------------------------------------------
// linkTelegramUnlink
// ---------------------------------------------------------------------------

describe('handleUnlink — DELETE /v1/me/link-telegram', () => {
    it('clears the chat id and returns { linked: false }', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);
        await users.setTelegramChatId(user.id, '111');

        const { provider } = authProviderFor(user.cognitoSub);
        const res = await handleUnlink(
            {
                authProvider: provider,
                userService: new UserService(users, silentLogger()),
                linkService: buildLinkService(users, codes),
                logger: silentLogger(),
            },
            eventWithClaims(user.cognitoSub),
        );
        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(JSON.parse(res.body), { linked: false });

        const reread = await users.findById(user.id);
        assert.strictEqual(reread?.telegramChatId, null);
    });

    it('is idempotent — returns 200 even when already unlinked', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);

        const { provider } = authProviderFor(user.cognitoSub);
        const res = await handleUnlink(
            {
                authProvider: provider,
                userService: new UserService(users, silentLogger()),
                linkService: buildLinkService(users, codes),
                logger: silentLogger(),
            },
            eventWithClaims(user.cognitoSub),
        );
        assert.strictEqual(res.statusCode, 200);
    });
});

// ---------------------------------------------------------------------------
// telegramWebhook
// ---------------------------------------------------------------------------

function webhookEvent(
    body: unknown,
    headers: APIGatewayProxyEventHeaders = {},
): APIGatewayProxyEvent {
    return {
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers,
        multiValueHeaders: {},
        httpMethod: 'POST',
        isBase64Encoded: false,
        path: '/v1/integrations/telegram/webhook',
        pathParameters: null,
        queryStringParameters: null,
        multiValueQueryStringParameters: null,
        stageVariables: null,
        resource: '/v1/integrations/telegram/webhook',
        requestContext: {
            requestId: 'req-test',
        } as never,
    };
}

interface ReplyRecorder {
    readonly calls: Array<{ chatId: string; text: string }>;
    readonly reply: (chatId: string, text: string) => Promise<void>;
}

function replyRecorder(opts: { throws?: boolean } = {}): ReplyRecorder {
    const calls: Array<{ chatId: string; text: string }> = [];
    return {
        calls,
        async reply(chatId, text) {
            calls.push({ chatId, text });
            if (opts.throws) throw new Error('telegram reply failed');
        },
    };
}

describe('handleWebhook — POST /v1/integrations/telegram/webhook', () => {
    it('rejects 401 when the secret header is missing', async () => {
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService: buildLinkService(
                    new InMemoryUserRepository(),
                    new InMemoryTelegramLinkCodeRepository(),
                ),
                replyToBot: replyRecorder().reply,
                logger: silentLogger(),
            },
            webhookEvent({ update_id: 1 }),
        );
        assert.strictEqual(res.statusCode, 401);
    });

    it('rejects 401 when the secret header mismatches', async () => {
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService: buildLinkService(
                    new InMemoryUserRepository(),
                    new InMemoryTelegramLinkCodeRepository(),
                ),
                replyToBot: replyRecorder().reply,
                logger: silentLogger(),
            },
            webhookEvent(
                { update_id: 1 },
                { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' },
            ),
        );
        assert.strictEqual(res.statusCode, 401);
    });

    it('valid /start <code> redeems the code + replies with success', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);
        const linkService = buildLinkService(
            users,
            codes,
            () => 'LIVE-CODE',
        );
        await linkService.startLink(user.id);

        const recorder = replyRecorder();
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService,
                replyToBot: recorder.reply,
                logger: silentLogger(),
            },
            webhookEvent(
                {
                    update_id: 1,
                    message: {
                        chat: { id: 987654321 },
                        text: '/start LIVE-CODE',
                    },
                },
                { 'X-Telegram-Bot-Api-Secret-Token': 'whsec-prod' },
            ),
        );
        assert.strictEqual(res.statusCode, 200);

        // Chat id was bound on the user row.
        const reread = await users.findById(user.id);
        assert.strictEqual(reread?.telegramChatId, '987654321');

        // Code consumed.
        assert.strictEqual(await codes.findByCode('LIVE-CODE'), null);

        // Confirmation reply sent.
        assert.strictEqual(recorder.calls.length, 1);
        assert.strictEqual(recorder.calls[0]!.chatId, '987654321');
        assert.match(recorder.calls[0]!.text, /Linked/);
    });

    it('unknown code → 200 acknowledged, failure reply, no link', async () => {
        const users = new InMemoryUserRepository();
        await seedUser(users);
        const codes = new InMemoryTelegramLinkCodeRepository();
        const recorder = replyRecorder();

        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService: buildLinkService(users, codes),
                replyToBot: recorder.reply,
                logger: silentLogger(),
            },
            webhookEvent(
                {
                    update_id: 2,
                    message: {
                        chat: { id: 111 },
                        text: '/start NOPE',
                    },
                },
                { 'X-Telegram-Bot-Api-Secret-Token': 'whsec-prod' },
            ),
        );
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(recorder.calls.length, 1);
        assert.match(recorder.calls[0]!.text, /invalid or expired/);
    });

    it('ignores non-/start messages with a 200 ack', async () => {
        const recorder = replyRecorder();
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService: buildLinkService(
                    new InMemoryUserRepository(),
                    new InMemoryTelegramLinkCodeRepository(),
                ),
                replyToBot: recorder.reply,
                logger: silentLogger(),
            },
            webhookEvent(
                {
                    update_id: 3,
                    message: { chat: { id: 222 }, text: 'hello bot' },
                },
                { 'X-Telegram-Bot-Api-Secret-Token': 'whsec-prod' },
            ),
        );
        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(recorder.calls.length, 0);
    });

    it('ignores updates with no message (group join, channel post)', async () => {
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService: buildLinkService(
                    new InMemoryUserRepository(),
                    new InMemoryTelegramLinkCodeRepository(),
                ),
                replyToBot: replyRecorder().reply,
                logger: silentLogger(),
            },
            webhookEvent(
                {
                    update_id: 4,
                    my_chat_member: { new_chat_member: { status: 'member' } },
                },
                { 'X-Telegram-Bot-Api-Secret-Token': 'whsec-prod' },
            ),
        );
        assert.strictEqual(res.statusCode, 200);
    });

    it('returns 200 ack on malformed JSON body', async () => {
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService: buildLinkService(
                    new InMemoryUserRepository(),
                    new InMemoryTelegramLinkCodeRepository(),
                ),
                replyToBot: replyRecorder().reply,
                logger: silentLogger(),
            },
            webhookEvent(
                'not-json-{{',
                { 'X-Telegram-Bot-Api-Secret-Token': 'whsec-prod' },
            ),
        );
        assert.strictEqual(res.statusCode, 200);
    });

    it('returns 503 when Telegram is not configured', async () => {
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService: null,
                replyToBot: replyRecorder().reply,
                logger: silentLogger(),
            },
            webhookEvent(
                { update_id: 5 },
                { 'X-Telegram-Bot-Api-Secret-Token': 'whsec-prod' },
            ),
        );
        assert.strictEqual(res.statusCode, 503);
    });

    it('reply-hook failure does not break the webhook contract', async () => {
        const users = new InMemoryUserRepository();
        const codes = new InMemoryTelegramLinkCodeRepository();
        const user = await seedUser(users);
        const linkService = buildLinkService(
            users,
            codes,
            () => 'LIVE-CODE-2',
        );
        await linkService.startLink(user.id);

        const recorder = replyRecorder({ throws: true });
        const res = await handleWebhook(
            {
                webhookSecret: 'whsec-prod',
                linkService,
                replyToBot: recorder.reply,
                logger: silentLogger(),
            },
            webhookEvent(
                {
                    update_id: 6,
                    message: {
                        chat: { id: 333 },
                        text: '/start LIVE-CODE-2',
                    },
                },
                { 'X-Telegram-Bot-Api-Secret-Token': 'whsec-prod' },
            ),
        );
        assert.strictEqual(res.statusCode, 200);
        // Despite the reply failure, the chat id was still bound.
        const reread = await users.findById(user.id);
        assert.strictEqual(reread?.telegramChatId, '333');
    });
});
