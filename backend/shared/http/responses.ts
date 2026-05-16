// EthioLink — API Gateway response builders.
//
// Single source of truth for the JSON envelope every Lambda returns. Error
// shape matches the contract in docs/architecture/API_SPEC.md:
//
//     { "error": { "code": "STRING_CODE", "message": "Human readable", "details": {} } }
//
// Status-code helpers map each documented error code to the canonical HTTP
// status. Handlers should reach for those (`unauthenticated()`, `notFound()`,
// ...) rather than calling `errorResponse` directly — that way every handler
// emits the same status for the same domain error.

import type { APIGatewayProxyResult } from 'aws-lambda';

/** Error codes documented in API_SPEC.md "Error codes (initial set)". */
export type ApiErrorCode =
    | 'UNAUTHENTICATED'
    | 'FORBIDDEN'
    | 'NOT_FOUND'
    | 'VALIDATION_ERROR'
    | 'CONFLICT'
    | 'SLOT_UNAVAILABLE'
    | 'RATE_LIMITED'
    | 'INTERNAL_ERROR'
    // Phase 9 Track 6 — paid featuring surface. `FEATURING_DISABLED`
    // is the kill-switch response when `featuring.enabled = false` on
    // the config. `PAYMENT_REQUIRED` covers the gateway-side declines
    // raised inside `FeaturingService.subscribe`.
    | 'FEATURING_DISABLED'
    | 'PAYMENT_REQUIRED';

const JSON_HEADERS = {
    'Content-Type': 'application/json',
} as const;

/** 200 OK with a JSON body. */
export function ok<T>(body: T): APIGatewayProxyResult {
    return {
        statusCode: 200,
        headers: JSON_HEADERS,
        body: JSON.stringify(body),
    };
}

/** 204 No Content. */
export function noContent(): APIGatewayProxyResult {
    return { statusCode: 204, headers: JSON_HEADERS, body: '' };
}

/** Generic error response. Prefer the typed helpers below in handlers. */
export function errorResponse(
    statusCode: number,
    code: ApiErrorCode,
    message: string,
    details?: Record<string, unknown>,
): APIGatewayProxyResult {
    return {
        statusCode,
        headers: JSON_HEADERS,
        body: JSON.stringify({
            error: {
                code,
                message,
                details: details ?? {},
            },
        }),
    };
}

export const unauthenticated = (message = 'Authentication required.'): APIGatewayProxyResult =>
    errorResponse(401, 'UNAUTHENTICATED', message);

export const forbidden = (message = 'Forbidden.'): APIGatewayProxyResult =>
    errorResponse(403, 'FORBIDDEN', message);

export const notFound = (message = 'Resource not found.'): APIGatewayProxyResult =>
    errorResponse(404, 'NOT_FOUND', message);

export const validationError = (
    message: string,
    details?: Record<string, unknown>,
): APIGatewayProxyResult => errorResponse(400, 'VALIDATION_ERROR', message, details);

export const conflict = (message: string): APIGatewayProxyResult =>
    errorResponse(409, 'CONFLICT', message);

export const internalError = (): APIGatewayProxyResult =>
    errorResponse(500, 'INTERNAL_ERROR', 'Internal server error.');
