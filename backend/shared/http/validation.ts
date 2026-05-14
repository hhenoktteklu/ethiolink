// EthioLink — generic HTTP body parsing and field validators.
//
// Extracted in Phase 3 from the per-handler-folder `_validators.ts`
// shims so that services, staff, availability, and any future handlers
// can share the same generic parsers without duplicating them.
// Domain-specific validators (LocalizedText, lat/long ranges, owner
// types, storage keys, etc.) continue to live in each folder's local
// `_validators.ts`; that file now re-exports the generics from here.
//
// Conventions match the original Phase 2 helpers byte-for-byte:
//   * `parseRequiredString` — non-empty after trim; rejects undefined/null.
//   * `parseOptionalString` — `undefined` / `null` / whitespace-only → `undefined`.
//     Use for create-side inputs where "no value" and "value not provided"
//     are equivalent.
//   * `parseStringOrNull` — `undefined` and `null` both yield `null`.
//     Callers use `'field' in body` to distinguish "absent" (no change)
//     from "explicit null" (clear the column) — the PATCH-semantic pattern.
//   * Strings are trimmed; whitespace-only is treated as empty.
//   * Max-length is post-trim.

export const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ValidationFailure extends Error {
    public readonly details: Record<string, unknown>;
    constructor(message: string, details: Record<string, unknown>) {
        super(message);
        this.name = 'ValidationFailure';
        this.details = details;
    }
}

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

export function parseRequiredString(
    value: unknown,
    field: string,
    max?: number,
): string {
    if (typeof value !== 'string') {
        throw new ValidationFailure(`${field} must be a string.`, { field });
    }
    const trimmed = value.trim();
    if (trimmed === '') {
        throw new ValidationFailure(`${field} must not be empty.`, { field });
    }
    if (max !== undefined && trimmed.length > max) {
        throw new ValidationFailure(
            `${field} must be ${max} characters or fewer.`,
            { field, max },
        );
    }
    return trimmed;
}

export function parseOptionalString(
    value: unknown,
    field: string,
    max?: number,
): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
        throw new ValidationFailure(`${field} must be a string.`, { field });
    }
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (max !== undefined && trimmed.length > max) {
        throw new ValidationFailure(
            `${field} must be ${max} characters or fewer.`,
            { field, max },
        );
    }
    return trimmed;
}

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

export function parseOptionalNonNegInt(
    value: unknown,
    field: string,
): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        !Number.isInteger(value) ||
        value < 0
    ) {
        throw new ValidationFailure(
            `${field} must be a non-negative integer.`,
            { field },
        );
    }
    return value;
}
