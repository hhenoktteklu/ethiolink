// EthioLink — Lambda handler for `GET /v1/admin/appointments`.
//
// Authenticated, ADMIN-only. Cross-business read-only listing across
// every appointment in the system. Reads bypass any admin service —
// no audit row is recorded for reads.
//
// Query parameters (all optional):
//   * status     — REQUESTED / ACCEPTED / REJECTED / CANCELLED / COMPLETED / NO_SHOW
//   * businessId — UUID; narrow to one business's queue
//   * customerId — UUID; narrow to one customer's history
//   * from       — ISO-8601 datetime, inclusive lower bound on `startsAt`
//   * to         — ISO-8601 datetime, exclusive upper bound on `startsAt`
//   * limit      — integer 1..100. Defaults to 50.
//
// Sort: `starts_at DESC, id DESC` — same order as the per-customer
// and per-business listings.

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../../shared/db/pgClient.js';
import {
    type AppointmentStatus,
    PgAppointmentsRepository,
} from '../../../shared/domains/appointments/appointmentsRepository.js';
import { toAppointmentView } from '../../../shared/domains/appointments/appointmentView.js';
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

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
    'REQUESTED',
    'ACCEPTED',
    'REJECTED',
    'CANCELLED',
    'COMPLETED',
    'NO_SHOW',
];

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const appointmentsRepo = new PgAppointmentsRepository(pool);

interface ParsedFilters {
    readonly status?: AppointmentStatus;
    readonly businessId?: string;
    readonly customerId?: string;
    readonly fromUtc?: Date;
    readonly toUtc?: Date;
    readonly limit: number;
}

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'admin.appointments.list',
    });

    try {
        const authz = await authorizeAdmin(event, authProvider, userService);
        if (!authz.ok) return authz.response;

        const parsed = parseQuery(event);
        if ('error' in parsed) return parsed.error;

        const rows = await appointmentsRepo.listAll(
            {
                status: parsed.status,
                businessId: parsed.businessId,
                customerId: parsed.customerId,
                fromUtc: parsed.fromUtc,
                toUtc: parsed.toUtc,
            },
            parsed.limit,
        );
        return ok({ items: rows.map(toAppointmentView) });
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
        logger.error('admin.appointments.list.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseQuery(
    event: APIGatewayProxyEvent,
): ParsedFilters | { readonly error: APIGatewayProxyResult } {
    const qs = event.queryStringParameters ?? {};

    let status: AppointmentStatus | undefined;
    const statusRaw = qs.status?.trim();
    if (statusRaw !== undefined && statusRaw !== '') {
        const upper = statusRaw.toUpperCase();
        if (!APPOINTMENT_STATUSES.includes(upper as AppointmentStatus)) {
            return {
                error: validationError(
                    `status must be one of: ${APPOINTMENT_STATUSES.join(', ')}.`,
                    { field: 'status', allowed: APPOINTMENT_STATUSES },
                ),
            };
        }
        status = upper as AppointmentStatus;
    }

    let businessId: string | undefined;
    const businessIdRaw = qs.businessId?.trim();
    if (businessIdRaw !== undefined && businessIdRaw !== '') {
        if (!UUID_RE.test(businessIdRaw)) {
            return {
                error: validationError('businessId must be a UUID.', {
                    field: 'businessId',
                }),
            };
        }
        businessId = businessIdRaw;
    }

    let customerId: string | undefined;
    const customerIdRaw = qs.customerId?.trim();
    if (customerIdRaw !== undefined && customerIdRaw !== '') {
        if (!UUID_RE.test(customerIdRaw)) {
            return {
                error: validationError('customerId must be a UUID.', {
                    field: 'customerId',
                }),
            };
        }
        customerId = customerIdRaw;
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
        businessId,
        customerId,
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
