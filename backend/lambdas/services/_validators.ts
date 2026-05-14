// EthioLink — service-domain request-body validators.
//
// Generic helpers (`ValidationFailure`, `UUID_RE`, `parseJsonObjectBody`,
// `parseRequiredUuid`) live in `backend/shared/http/validation.ts` since
// Phase 3; this file keeps the service-domain-specific bits and
// re-exports the generics so handlers have a single import source.
//
// PATCH semantics:
//   * Each handler gates each field on `'foo' in obj` to distinguish
//     "absent" from "explicit null".
//   * `name` and `durationMinutes` are NOT NULL in the DB and cannot be
//     cleared; their parsers refuse `null`.
//   * `description` and `priceEtb` are nullable in the DB; their `*OrNull`
//     parsers map `undefined`/`null` → `null` (the "clear the column"
//     path on patch, or the "no value" path on create).

import type { LocalizedText } from '../../shared/domains/categories/categoryRepository.js';
import {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseRequiredUuid,
} from '../../shared/http/validation.js';

export {
    UUID_RE,
    ValidationFailure,
    parseJsonObjectBody,
    parseRequiredUuid,
};

export const FieldLimits = Object.freeze({
    NAME_MAX: 200,
    DESCRIPTION_MAX: 5000,
    /** Max bookable service duration in minutes (12 hours). */
    DURATION_MAX_MINUTES: 720,
    /** Max price in ETB. Below the `numeric(12,2)` DB ceiling; sanity guard for fat-fingered prices. */
    PRICE_MAX_ETB: 9_999_999.99,
});

// ---------------------------------------------------------------------------
// LocalizedText parsers
//
// Two variants:
//   * `parseLocalizedTextRequired` — rejects `undefined`/`null` outright.
//     Used for create-`name` and patch-`name` (DB is NOT NULL).
//   * `parseLocalizedTextOrNull` — `undefined`/`null` → `null` (clear or
//     no value). Used for `description`.
// ---------------------------------------------------------------------------

export function parseLocalizedTextRequired(
    value: unknown,
    fieldPath: string,
    max: number,
): LocalizedText {
    if (value === undefined || value === null) {
        throw new ValidationFailure(`${fieldPath} is required.`, { field: fieldPath });
    }
    return validateLocalizedTextObject(value, fieldPath, max);
}

export function parseLocalizedTextOrNull(
    value: unknown,
    fieldPath: string,
    max: number,
): LocalizedText | null {
    if (value === undefined || value === null) return null;
    return validateLocalizedTextObject(value, fieldPath, max);
}

function validateLocalizedTextObject(
    value: unknown,
    fieldPath: string,
    max: number,
): LocalizedText {
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new ValidationFailure(`${fieldPath} must be an object.`, {
            field: fieldPath,
        });
    }
    const obj = value as Record<string, unknown>;
    const en = obj.en;
    if (typeof en !== 'string') {
        throw new ValidationFailure(`${fieldPath}.en must be a string.`, {
            field: `${fieldPath}.en`,
        });
    }
    const enTrimmed = en.trim();
    if (enTrimmed === '') {
        throw new ValidationFailure(`${fieldPath}.en must not be empty.`, {
            field: `${fieldPath}.en`,
        });
    }
    if (enTrimmed.length > max) {
        throw new ValidationFailure(
            `${fieldPath}.en must be ${max} characters or fewer.`,
            { field: `${fieldPath}.en`, max },
        );
    }
    const out: { en: string; am?: string } = { en: enTrimmed };
    if (obj.am !== undefined && obj.am !== null) {
        if (typeof obj.am !== 'string') {
            throw new ValidationFailure(`${fieldPath}.am must be a string.`, {
                field: `${fieldPath}.am`,
            });
        }
        const amTrimmed = obj.am.trim();
        if (amTrimmed.length > max) {
            throw new ValidationFailure(
                `${fieldPath}.am must be ${max} characters or fewer.`,
                { field: `${fieldPath}.am`, max },
            );
        }
        if (amTrimmed !== '') out.am = amTrimmed;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Numeric parsers
// ---------------------------------------------------------------------------

/** Positive integer with optional inclusive upper cap. Rejects `null`/`undefined`. */
export function parsePositiveIntegerRequired(
    value: unknown,
    field: string,
    max?: number,
): number {
    if (value === undefined || value === null) {
        throw new ValidationFailure(`${field} is required.`, { field });
    }
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value <= 0
    ) {
        throw new ValidationFailure(
            `${field} must be a positive integer.`,
            { field },
        );
    }
    if (max !== undefined && value > max) {
        throw new ValidationFailure(
            `${field} must be ${max} or fewer.`,
            { field, max },
        );
    }
    return value;
}

/**
 * Non-negative number with up to 2 decimal places. Accepts `undefined`/`null`
 * as `null` (clear or no value). The optional `max` is the upper cap on
 * the magnitude.
 */
export function parsePriceOrNull(
    value: unknown,
    field: string,
    max: number,
): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationFailure(
            `${field} must be a number or null.`,
            { field },
        );
    }
    if (value < 0) {
        throw new ValidationFailure(
            `${field} must be greater than or equal to 0.`,
            { field },
        );
    }
    if (value > max) {
        throw new ValidationFailure(
            `${field} must be ${max} or fewer.`,
            { field, max },
        );
    }
    // numeric(12,2): reject values that would lose precision past two decimals.
    const cents = Math.round(value * 100);
    if (Math.abs(value * 100 - cents) > 1e-6) {
        throw new ValidationFailure(
            `${field} must have at most 2 decimal places.`,
            { field },
        );
    }
    return value;
}
