// EthioLink — request-context propagation via AsyncLocalStorage.
//
// Phase 8 observability primitive: stash the current request's
// identifying fields (API Gateway `requestId`, Cognito `sub`,
// route, method) in an `AsyncLocalStorage` so deep call sites
// (the notification dispatcher, repository helpers, the slot
// computer) can read them without explicit argument threading.
//
// Usage from a Lambda handler:
//
//     import { withRequestContext, buildRequestContextFromApiGateway } from
//         '../../shared/observability/correlationId.js';
//
//     export const handler = async (event: APIGatewayProxyEvent) => {
//         const ctx = buildRequestContextFromApiGateway(event, 'businesses.get');
//         return withRequestContext(ctx, async () => {
//             // ... existing handler body ...
//             // Anything called from here can read the context via
//             // `getCurrentRequestContext()` — no need to pass it.
//         });
//     };
//
// Layering note:
//   * This module imports nothing from `shared/logging`. The
//     logger module reads the current context via the optional
//     `contextProvider` hook on `LoggerOptions`; consumers wire
//     `getCurrentRequestContext` into that hook at cold-start.
//   * `AsyncLocalStorage` is a Node.js core API (no dependency).
//     Lambda's Node 20 runtime supports it without flags.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { APIGatewayProxyEvent, ScheduledEvent } from 'aws-lambda';

/**
 * Shape of the per-request context the ALS scope carries.
 * Every field is nullable because not every Lambda invocation
 * has every field (e.g. scheduled lambdas have no
 * `requestContext`, public endpoints have no Cognito sub).
 */
export interface RequestContext {
    /** API Gateway `event.requestContext.requestId`. `null` for
     *  EventBridge / direct-invoke paths. */
    readonly requestId: string | null;
    /** Cognito principal subject from the JWT. `null` on public
     *  routes or when the authorizer hasn't run yet. */
    readonly cognitoSub: string | null;
    /** Path template (e.g. `/v1/businesses/{businessId}`). `null`
     *  when the source isn't API Gateway. */
    readonly route: string | null;
    /** HTTP method (`GET` / `POST` / ...). `null` when the source
     *  isn't API Gateway. */
    readonly method: string | null;
    /** Logical handler name (e.g. `businesses.get`). Always set
     *  — every wrapper invocation passes one. */
    readonly handler: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` inside an ALS scope that exposes `ctx` via
 * `getCurrentRequestContext`. Returns whatever `fn` returns.
 *
 * Nesting `withRequestContext` is supported — inner scopes
 * shadow outer ones. The Lambda case always has exactly one
 * level (the handler itself); the nesting capability is there
 * for future composition (e.g. a SQS message batch handler that
 * stamps a per-message context inside the batch-level one).
 */
export function withRequestContext<T>(
    ctx: RequestContext,
    fn: () => Promise<T>,
): Promise<T> {
    return storage.run(ctx, fn);
}

/**
 * Read the current ALS context, or `undefined` if `fn` was not
 * called inside a `withRequestContext` scope. Most call sites
 * (loggers, the dispatcher) treat `undefined` as a no-op and
 * emit logs without the correlation block — the absence of the
 * context isn't an error.
 */
export function getCurrentRequestContext(): RequestContext | undefined {
    return storage.getStore();
}

/**
 * Adapter: build a `RequestContext` from the API Gateway event
 * the Lambda receives. Pulls `requestId` + the Cognito sub from
 * the authorizer claims + the path template + method.
 *
 * `handlerName` is the caller's logical name — typically
 * `<area>.<verb>` (e.g. `appointments.create`). It's the only
 * field the caller has to supply.
 */
export function buildRequestContextFromApiGateway(
    event: APIGatewayProxyEvent,
    handlerName: string,
): RequestContext {
    const claims = event.requestContext?.authorizer?.claims as
        | Record<string, string | undefined>
        | undefined;
    const cognitoSub =
        (claims && typeof claims.sub === 'string' ? claims.sub : null) ?? null;

    return Object.freeze<RequestContext>({
        requestId: event.requestContext?.requestId ?? null,
        cognitoSub,
        route: event.requestContext?.resourcePath ?? null,
        method: event.httpMethod ?? null,
        handler: handlerName,
    });
}

/**
 * Adapter: build a `RequestContext` from an EventBridge
 * `ScheduledEvent`. No `requestId` / `cognitoSub` / `route` /
 * `method` — only the handler name. The rule ARN is stashed as
 * a side-channel string the logger can include if it wants.
 */
export function buildRequestContextFromScheduled(
    event: ScheduledEvent,
    handlerName: string,
): RequestContext {
    return Object.freeze<RequestContext>({
        requestId: event.id ?? null,
        cognitoSub: null,
        route: event.resources?.[0] ?? null,
        method: null,
        handler: handlerName,
    });
}

/**
 * Convert the current ALS context (or the empty record when
 * outside a scope) into a flat `Record<string, unknown>` for
 * logger / metric consumption. Null fields are stripped so the
 * emitted log line stays clean.
 *
 * This is the function logger consumers wire into
 * `LoggerOptions.contextProvider` so every log line auto-stamps
 * the correlation fields.
 */
export function getCurrentRequestContextRecord(): Record<string, unknown> {
    const ctx = storage.getStore();
    if (!ctx) return {};
    const out: Record<string, unknown> = { handler: ctx.handler };
    if (ctx.requestId !== null) out.requestId = ctx.requestId;
    if (ctx.cognitoSub !== null) out.cognitoSub = ctx.cognitoSub;
    if (ctx.route !== null) out.route = ctx.route;
    if (ctx.method !== null) out.method = ctx.method;
    return out;
}
