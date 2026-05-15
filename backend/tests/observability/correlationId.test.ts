// EthioLink — correlationId.ts unit tests.
//
// Tiny suite covering the ALS round-trip:
//
//   * `getCurrentRequestContext()` returns `undefined` outside
//     a `withRequestContext` scope.
//   * Inside a scope, the same `RequestContext` object is
//     returned (referential equality is fine — the type is
//     frozen).
//   * `getCurrentRequestContextRecord()` produces the expected
//     flat shape with null fields stripped.
//   * Nested scopes shadow correctly.
//   * The two builders (`buildRequestContextFromApiGateway`,
//     `buildRequestContextFromScheduled`) populate the fields the
//     ALS scope expects.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { APIGatewayProxyEvent, ScheduledEvent } from 'aws-lambda';

import {
    buildRequestContextFromApiGateway,
    buildRequestContextFromScheduled,
    getCurrentRequestContext,
    getCurrentRequestContextRecord,
    withRequestContext,
    type RequestContext,
} from '../../shared/observability/correlationId.js';

const SAMPLE_CTX: RequestContext = Object.freeze({
    requestId: 'req-1',
    cognitoSub: 'cog-sub-1',
    route: '/v1/businesses/{businessId}',
    method: 'GET',
    handler: 'businesses.get',
});

describe('withRequestContext + getCurrentRequestContext', () => {
    it('returns undefined outside any scope', () => {
        assert.strictEqual(getCurrentRequestContext(), undefined);
    });

    it('returns the active context inside a scope', async () => {
        await withRequestContext(SAMPLE_CTX, async () => {
            const seen = getCurrentRequestContext();
            assert.deepStrictEqual(seen, SAMPLE_CTX);
        });
    });

    it('propagates through async boundaries (Promise.resolve, setTimeout)', async () => {
        await withRequestContext(SAMPLE_CTX, async () => {
            await Promise.resolve();
            assert.deepStrictEqual(getCurrentRequestContext(), SAMPLE_CTX);

            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            assert.deepStrictEqual(getCurrentRequestContext(), SAMPLE_CTX);
        });
    });

    it('shadows the outer context inside a nested scope', async () => {
        const inner: RequestContext = { ...SAMPLE_CTX, handler: 'inner' };
        await withRequestContext(SAMPLE_CTX, async () => {
            await withRequestContext(inner, async () => {
                assert.strictEqual(getCurrentRequestContext()?.handler, 'inner');
            });
            // Back to outer after the inner scope completes.
            assert.strictEqual(getCurrentRequestContext()?.handler, 'businesses.get');
        });
    });

    it('returns the function value unchanged', async () => {
        const result = await withRequestContext(SAMPLE_CTX, async () => 42);
        assert.strictEqual(result, 42);
    });
});

describe('getCurrentRequestContextRecord', () => {
    it('returns an empty object outside any scope', () => {
        assert.deepStrictEqual(getCurrentRequestContextRecord(), {});
    });

    it('returns a flat record with all populated fields', async () => {
        await withRequestContext(SAMPLE_CTX, async () => {
            assert.deepStrictEqual(getCurrentRequestContextRecord(), {
                handler: 'businesses.get',
                requestId: 'req-1',
                cognitoSub: 'cog-sub-1',
                route: '/v1/businesses/{businessId}',
                method: 'GET',
            });
        });
    });

    it('strips null fields from the record', async () => {
        const partial: RequestContext = {
            requestId: null,
            cognitoSub: null,
            route: null,
            method: null,
            handler: 'scheduled.run',
        };
        await withRequestContext(partial, async () => {
            assert.deepStrictEqual(getCurrentRequestContextRecord(), {
                handler: 'scheduled.run',
            });
        });
    });
});

describe('buildRequestContextFromApiGateway', () => {
    it('extracts requestId, cognito sub, route, and method', () => {
        const event = {
            httpMethod: 'POST',
            requestContext: {
                requestId: 'req-xyz',
                resourcePath: '/v1/businesses',
                authorizer: { claims: { sub: 'cog-sub-xyz' } },
            },
        } as unknown as APIGatewayProxyEvent;

        const ctx = buildRequestContextFromApiGateway(event, 'businesses.create');
        assert.deepStrictEqual(ctx, {
            requestId: 'req-xyz',
            cognitoSub: 'cog-sub-xyz',
            route: '/v1/businesses',
            method: 'POST',
            handler: 'businesses.create',
        });
    });

    it('returns null for cognito sub on public routes (no authorizer)', () => {
        const event = {
            httpMethod: 'GET',
            requestContext: {
                requestId: 'req-public',
                resourcePath: '/v1/categories',
                // no authorizer
            },
        } as unknown as APIGatewayProxyEvent;

        const ctx = buildRequestContextFromApiGateway(event, 'categories.list');
        assert.strictEqual(ctx.cognitoSub, null);
        assert.strictEqual(ctx.requestId, 'req-public');
        assert.strictEqual(ctx.handler, 'categories.list');
    });
});

describe('buildRequestContextFromScheduled', () => {
    it('extracts the event id and rule ARN', () => {
        const event = {
            id: 'evt-1',
            resources: ['arn:aws:events:eu-west-1:123:rule/foo'],
        } as unknown as ScheduledEvent;

        const ctx = buildRequestContextFromScheduled(event, 'scheduled.reminders');
        assert.deepStrictEqual(ctx, {
            requestId: 'evt-1',
            cognitoSub: null,
            route: 'arn:aws:events:eu-west-1:123:rule/foo',
            method: null,
            handler: 'scheduled.reminders',
        });
    });
});
