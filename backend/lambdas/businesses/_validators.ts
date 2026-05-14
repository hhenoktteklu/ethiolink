// EthioLink — business-specific request-body validators.
//
// Generic helpers (`ValidationFailure`, `UUID_RE`, `parseJsonObjectBody`,
// `parseRequiredUuid`, `parseStringOrNull`, `parseRequiredString`,
// `parseOptionalString`, `parseOptionalNonNegInt`) live in
// `backend/shared/http/validation.ts` since Phase 3; this file keeps
// only the validators that need business-domain types or constants,
// and re-exports the generic helpers so existing handler imports do
// not need to change.

import type { LocalizedText } from '../../shared/domains/categories/categoryRepository.js';
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

/** Field-length caps. Re-used by handlers to advertise limits in error details. */
export const FieldLimits = Object.freeze({
    NAME_MAX: 200,
    DESCRIPTION_MAX: 5000,
    CITY_MAX: 100,
    ADDRESS_MAX: 500,
    CONTACT_MAX: 50,
});

/**
 * `description` is a `LocalizedText` object. MVP requires `en` when
 * present; `am` is optional and accepted if it appears. Empty `en` is
 * rejected as "description provided but empty" — clients should send
 * `null` to clear.
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
