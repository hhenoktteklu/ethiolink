// EthioLink — availability-domain request-body validators.
//
// Generic helpers live in `shared/http/validation.ts`; this file owns the
// availability-specific parsers:
//
//   * `parseTime` — accepts `HH:MM` or `HH:MM:SS`, returns the
//     normalized `HH:MM:SS` form the service layer expects. The
//     normalization is the handler's job — `AvailabilityService`
//     itself is strict and would reject `HH:MM`.
//   * `parseDate` — `YYYY-MM-DD`.
//   * `parseWeekday` — integer in `[0, 6]`.
//   * `parseOptionalBoolean` — for `isClosed`.

export {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
} from '../../shared/http/validation.js';

import { ValidationFailure } from '../../shared/http/validation.js';

/**
 * Accepts `HH:MM` or `HH:MM:SS`. Hours range `00..24` (the `24:00:00`
 * sentinel for end-of-day is allowed; the service-layer constraint
 * `end_time > start_time` does the heavy lifting around validity).
 * Returns normalized `HH:MM:SS`.
 */
const TIME_RE = /^([01]\d|2[0-4]):[0-5]\d(:[0-5]\d)?$/;

export function parseTime(value: unknown, fieldPath: string): string {
    if (typeof value !== 'string') {
        throw new ValidationFailure(`${fieldPath} must be a string.`, {
            field: fieldPath,
        });
    }
    const trimmed = value.trim();
    if (!TIME_RE.test(trimmed)) {
        throw new ValidationFailure(
            `${fieldPath} must be HH:MM or HH:MM:SS.`,
            { field: fieldPath, value },
        );
    }
    return trimmed.length === 5 ? `${trimmed}:00` : trimmed;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseDate(value: unknown, fieldPath: string): string {
    if (typeof value !== 'string' || !DATE_RE.test(value)) {
        throw new ValidationFailure(
            `${fieldPath} must be a YYYY-MM-DD date.`,
            { field: fieldPath, value },
        );
    }
    return value;
}

export function parseWeekday(value: unknown, fieldPath: string): number {
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > 6
    ) {
        throw new ValidationFailure(
            `${fieldPath} must be an integer 0..6.`,
            { field: fieldPath, value },
        );
    }
    return value;
}

export function parseOptionalBoolean(
    value: unknown,
    fieldPath: string,
): boolean | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') {
        throw new ValidationFailure(
            `${fieldPath} must be a boolean.`,
            { field: fieldPath, value },
        );
    }
    return value;
}
