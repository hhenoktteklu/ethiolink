// EthioLink — appointment-domain request validators.
//
// Generic helpers (`ValidationFailure`, `UUID_RE`, `parseJsonObjectBody`,
// `parseRequiredUuid`, `parseStringOrNull`) live in
// `backend/shared/http/validation.ts`. This file owns the
// appointment-specific bits — payment method, ISO start timestamps,
// status filters, and notes length limits — and re-exports the
// generics so handlers have one import source.
//
// Naming convention follows `services/_validators.ts`:
// `parse<Field>` for required values, `parse<Field>OrNull` /
// `parse<Field>Optional` for nullable / absent inputs.

import type {
    AppointmentStatus,
    PaymentMethod,
} from '../../shared/domains/appointments/appointmentsRepository.js';
import {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseRequiredUuid,
    parseStringOrNull,
} from '../../shared/http/validation.js';

export {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseRequiredUuid,
    parseStringOrNull,
};

export const FieldLimits = Object.freeze({
    /** Max length of the customer-supplied `notes` string. */
    NOTES_MAX: 2000,
});

const PAYMENT_METHODS: readonly PaymentMethod[] = ['CASH', 'ONLINE_PENDING'];

const APPOINTMENT_STATUSES: readonly AppointmentStatus[] = [
    'REQUESTED',
    'ACCEPTED',
    'REJECTED',
    'CANCELLED',
    'COMPLETED',
    'NO_SHOW',
];

/**
 * Required `paymentMethod`. Must be one of the documented values; the
 * service routes to the matching `PaymentGateway`.
 */
export function parsePaymentMethod(value: unknown): PaymentMethod {
    if (typeof value !== 'string') {
        throw new ValidationFailure('paymentMethod must be a string.', {
            field: 'paymentMethod',
        });
    }
    const trimmed = value.trim().toUpperCase();
    if (!PAYMENT_METHODS.includes(trimmed as PaymentMethod)) {
        throw new ValidationFailure(
            `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}.`,
            { field: 'paymentMethod', allowed: PAYMENT_METHODS },
        );
    }
    return trimmed as PaymentMethod;
}

/**
 * Required `startsAt`. Must be a parseable ISO-8601 datetime; the
 * service normalizes it to UTC. Empty / whitespace-only / non-string
 * inputs are rejected before `new Date(...)` to keep the error
 * message helpful.
 */
export function parseStartsAt(value: unknown, field = 'startsAt'): string {
    if (typeof value !== 'string') {
        throw new ValidationFailure(`${field} must be a string.`, { field });
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        throw new ValidationFailure(`${field} must not be empty.`, { field });
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        throw new ValidationFailure(
            `${field} must be a valid ISO-8601 datetime.`,
            { field, value: trimmed },
        );
    }
    return trimmed;
}

/** Optional appointment-status filter for list endpoints. */
export function parseAppointmentStatusOptional(
    raw: string | undefined,
    field = 'status',
): AppointmentStatus | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim().toUpperCase();
    if (trimmed === '') return undefined;
    if (!APPOINTMENT_STATUSES.includes(trimmed as AppointmentStatus)) {
        throw new ValidationFailure(
            `${field} must be one of: ${APPOINTMENT_STATUSES.join(', ')}.`,
            { field, allowed: APPOINTMENT_STATUSES },
        );
    }
    return trimmed as AppointmentStatus;
}

/**
 * Optional ISO-8601 datetime filter for list endpoints. Returns a
 * `Date` (the repository accepts `Date` on `ListAppointmentsFilters`)
 * or `undefined`.
 */
export function parseIsoDatetimeOptional(
    raw: string | undefined,
    field: string,
): Date | undefined {
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    if (trimmed === '') return undefined;
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) {
        throw new ValidationFailure(
            `${field} must be a valid ISO-8601 datetime.`,
            { field, value: trimmed },
        );
    }
    return parsed;
}

/** Optional `notes` body field. `null`, `undefined`, and `""` all map to `null`. */
export function parseNotesOrNull(value: unknown): string | null {
    return parseStringOrNull(value, 'notes', FieldLimits.NOTES_MAX);
}
