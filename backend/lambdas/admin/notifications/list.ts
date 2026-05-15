// EthioLink — Lambda handler for `GET /v1/admin/notifications`.
//
// Authenticated, ADMIN-only. Read-only listing of every
// `notification_logs` row matching the supplied filters. The
// admin dashboard's notification-troubleshooting surface — see
// `admin/src/pages/NotificationsPage.tsx`. No mutations here: a
// future retry / clear-failed flow is its own commit.
//
// Query parameters (all optional):
//   * status          — QUEUED / SENT / DELIVERED / FAILED
//   * channel         — SMS / EMAIL / TELEGRAM / PUSH / MOCK
//   * recipientUserId — UUID
//   * from            — ISO-8601 datetime, inclusive lower bound
//                       on `created_at`
//   * to              — ISO-8601 datetime, exclusive upper bound
//                       on `created_at`
//   * limit           — integer 1..100. Defaults to 100.
//
// Sort: `created_at DESC, id DESC` — newest attempts first,
// matching the admin's "what just went wrong" mental model.
//
// Mirrors the structure of `admin/appointments/list.ts` so a
// future generalization can extract the shared validation /
// auth / response helpers if it makes sense to do so. For now
// each handler stays standalone — the duplication is small and
// the seam is obvious.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadConfig } from '../../../shared/config/loadConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import {
    type NotificationChannel,
    PgNotificationLogRepository,
    type NotificationStatus,
} from '../../../shared/domains/notifications/notificationLogRepository.js';
import { toNotificationLogView } from '../../../shared/domains/notifications/notificationLogView.js';
import { PgUserRepository } from '../../../shared/domains/users/userRepository.js';
import { UserService } from '../../../shared/domains/users/userService.js';
import {
    internalError,
    ok,
    unauthenticated,
    validationError,
} from '../../../shared/http/responses.js';
import { UUID_RE } from '../../../shared/http/validation.js';
import { createLogger } from '../../../shared/logging/logger.js';

import { authorizeAdmin } from '../_authz.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 100;

const NOTIFICATION_STATUSES: readonly NotificationStatus[] = [
    'QUEUED',
    'SENT',
    'DELIVERED',
    'FAILED',
];

const NOTIFICATION_CHANNELS: readonly NotificationChannel[] = [
    'SMS',
    'EMAIL',
    'TELEGRAM',
    'PUSH',
    'MOCK',
];

const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const notificationLogRepo = new PgNotificationLogRepository(pool);

interface ParsedFilters {
    readonly status?: NotificationStatus;
    readonly channel?: NotificationChannel;
    readonly recipientUserId?: string;
    readonly fromUtc?: Date;
    readonly toUtc?: Date;
    readonly limit: number;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.notifications.list',
    });

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const parsed = parseQuery(event);
        if ('error' in parsed) return parsed.error;

        const rows = await notificationLogRepo.listForAdmin(
            {
                status: parsed.status,
                channel: parsed.channel,
                recipientUserId: parsed.recipientUserId,
                fromUtc: parsed.fromUtc,
                toUtc: parsed.toUtc,
            },
            parsed.limit,
        );
        return ok({ items: rows.map(toNotificationLogView) });
    } catch (err) {
        if (
            err instanceof TokenExpiredError ||
            err instanceof TokenInvalidError ||
            err instanceof ClaimsMalformedError ||
            err instanceof AuthError
        ) {
            logger.warn('auth.unauthenticated', { reason: err.message });
            return unauthenticated(err.message);
        }
        logger.error('admin.notifications.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseQuery(
    event: APIGatewayProxyEvent,
): ParsedFilters | { readonly error: APIGatewayProxyResult } {
    const qs = event.queryStringParameters ?? {};

    let status: NotificationStatus | undefined;
    const statusRaw = qs.status?.trim();
    if (statusRaw !== undefined && statusRaw !== '') {
        const upper = statusRaw.toUpperCase();
        if (!NOTIFICATION_STATUSES.includes(upper as NotificationStatus)) {
            return {
                error: validationError(
                    `status must be one of: ${NOTIFICATION_STATUSES.join(', ')}.`,
                    { field: 'status', allowed: NOTIFICATION_STATUSES },
                ),
            };
        }
        status = upper as NotificationStatus;
    }

    let channel: NotificationChannel | undefined;
    const channelRaw = qs.channel?.trim();
    if (channelRaw !== undefined && channelRaw !== '') {
        const upper = channelRaw.toUpperCase();
        if (!NOTIFICATION_CHANNELS.includes(upper as NotificationChannel)) {
            return {
                error: validationError(
                    `channel must be one of: ${NOTIFICATION_CHANNELS.join(', ')}.`,
                    { field: 'channel', allowed: NOTIFICATION_CHANNELS },
                ),
            };
        }
        channel = upper as NotificationChannel;
    }

    let recipientUserId: string | undefined;
    const recipientRaw = qs.recipientUserId?.trim();
    if (recipientRaw !== undefined && recipientRaw !== '') {
        if (!UUID_RE.test(recipientRaw)) {
            return {
                error: validationError('recipientUserId must be a UUID.', {
                    field: 'recipientUserId',
                }),
            };
        }
        recipientUserId = recipientRaw;
    }

    const fromUtc = parseOptionalDatetime(qs.from, 'from');
    if (fromUtc && 'error' in fromUtc) return fromUtc;

    const toUtc = parseOptionalDatetime(qs.to, 'to');
    if (toUtc && 'error' in toUtc) return toUtc;

    let limit = DEFAULT_LIMIT;
    const limitRaw = qs.limit?.trim();
    if (limitRaw !== undefined && limitRaw !== '') {
        const parsed = Number.parseInt(limitRaw, 10);
        if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
            return {
                error: validationError(
                    `limit must be an integer between 1 and ${MAX_LIMIT}.`,
                    { field: 'limit', value: limitRaw },
                ),
            };
        }
        limit = parsed;
    }

    return {
        status,
        channel,
        recipientUserId,
        fromUtc: fromUtc ? fromUtc.value : undefined,
        toUtc: toUtc ? toUtc.value : undefined,
        limit,
    };
}

function parseOptionalDatetime(
    raw: string | undefined,
    field: string,
):
    | { readonly value: Date }
    | { readonly error: APIGatewayProxyResult }
    | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        return {
            error: validationError(
                `${field} must be a valid ISO-8601 datetime.`,
                { field, value: trimmed },
            ),
        };
    }
    return { value: parsed };
}
