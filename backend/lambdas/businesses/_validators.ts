// EthioLink — request-body validators shared by the business
// write handlers (create, patch).
//
// Each validator accepts `unknown` and either returns a narrowed,
// trimmed value or throws `ValidationFailure`. The handler catches the
// failure and maps it to a 400 VALIDATION_ERROR response, including
// the `details` payload the validator attached.
//
// Hand-written because the project has not yet introduced zod. The
// surface here is small enough (one entity, ~10 fields) that the cost
// of a dependency is not justified. When Phase 3+ adds services,
// staff, and appointments, we should reconsider zod.
//
// Conventions:
//   * `undefined` from `obj.foo` (field absent) → `null` for create
//     (the row is fresh); patch handlers gate each field on `'foo' in obj`
//     so absence means "no change".
//   * Explicit `null` → `null` (clear the column).
//   * Strings are trimmed; whitespace-only → `null`.
//   * Max-length checks apply post-trim.

import type { LocalizedText } from '../../shared/domains/categories/categoryRepository.js';

export const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Field-length caps. Re-used by handlers to advertise limits in error details. */
export const FieldLimits = Object.freeze({
    NAME_MAX: 200,
    DESCRIPTION_MAX: 5000,
    CITY_MAX: 100,
    ADDRESS_MAX: 500,
    CONTACT_MAX: 50,
});

export class ValidationFailure extends Error {
    public readonly details: Record<string, unknown>;
    constructor(message: string, details: Record<string, unknown>) {
        super(message);
        this.name = 'ValidationFailure';
        this.details = details;
    }
}

/** Parse a JSON object body. Throws on missing / non-object input. */
export function parseJsonObjectBody(
    rawBody: string | null,
    options: { allowEmpty: boolean },
): Record<string, unknown> {
    if (rawBody === null || rawBody.trim() === '') {
        if (options.allowEmpty) return {};
        throw new ValidationFailure('Body is required.', { field: 'body' });
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(rawBody);
    } catch {
        throw new ValidationFailure('Body must be valid JSON.', { field: 'body' });
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new ValidationFailure('Body must be a JSON object.', { field: 'body' });
    }
    return parsed as Record<string, unknown>;
}

export function parseRequiredUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
        throw new ValidationFailure(`${field} must be a UUID.`, { field });
    }
    return value;
}

/**
 * Optional string field. Trims, treats whitespace-only as null. `undefined`
 * and `null` both yield `null` — handlers use `'field' in body` to detect
 * "absent" vs "explicit null" for patch semantics.
 */
export function parseStringOrNull(
    value: unknown,
    field: string,
    max: number,
): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
        throw new ValidationFailure(`${field} must be a string or null.`, { field });
    }
    const trimmed = value.trim();
    if (trimmed === '') return null;
    if (trimmed.length > max) {
        throw new ValidationFailure(
            `${field} must be ${max} characters or fewer.`,
            { field, max },
        );
    }
    return trimmed;
}

/**
 * `description` is a `LocalizedText` object. MVP requires `en` when present;
 * `am` is optional and accepted if it appears. Empty `en` is rejected as
 * "description provided but empty" — clients should send `null` to clear.
 */
export function parseDescriptionOrNull(value: unknown): LocalizedText | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationFailure('description must be an object or null.', {
            field: 'description',
        });
    }
    const obj = value as Record<string, unknown>;
    const en = obj.en;
    if (typeof en !== 'string') {
        throw new ValidationFailure('description.en must be a string.', {
            field: 'description.en',
        });
    }
    const enTrimmed = en.trim();
    if (enTrimmed === '') {
        throw new ValidationFailure('description.en must not be empty.', {
            field: 'description.en',
        });
    }
    if (enTrimmed.length > FieldLimits.DESCRIPTION_MAX) {
        throw new ValidationFailure(
            `description.en must be ${FieldLimits.DESCRIPTION_MAX} characters or fewer.`,
            { field: 'description.en', max: FieldLimits.DESCRIPTION_MAX },
        );
    }
    const out: { en: string; am?: string } = { en: enTrimmed };
    if (obj.am !== undefined && obj.am !== null) {
        if (typeof obj.am !== 'string') {
            throw new ValidationFailure('description.am must be a string.', {
                field: 'description.am',
            });
        }
        const amTrimmed = obj.am.trim();
        if (amTrimmed.length > FieldLimits.DESCRIPTION_MAX) {
            throw new ValidationFailure(
                `description.am must be ${FieldLimits.DESCRIPTION_MAX} characters or fewer.`,
                { field: 'description.am', max: FieldLimits.DESCRIPTION_MAX },
            );
        }
        if (amTrimmed !== '') out.am = amTrimmed;
    }
    return out;
}

export function parseLatitude(value: unknown): number | null {
    return parseCoordinate(value, 'latitude', -90, 90);
}

export function parseLongitude(value: unknown): number | null {
    return parseCoordinate(value, 'longitude', -180, 180);
}

function parseCoordinate(
    value: unknown,
    field: string,
    min: number,
    max: number,
): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationFailure(`${field} must be a number or null.`, { field });
    }
    if (value < min || value > max) {
        throw new ValidationFailure(
            `${field} must be between ${min} and ${max}.`,
            { field, min, max },
        );
    }
    return value;
}
