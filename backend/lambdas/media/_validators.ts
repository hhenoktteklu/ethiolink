// EthioLink — request-body validators for the media handlers.
//
// Hand-written, mirroring the pattern in `businesses/_validators.ts`.
// We are intentionally duplicating the small generic helpers
// (`ValidationFailure`, `parseJsonObjectBody`, `parseRequiredUuid`)
// between the two handler folders rather than reaching across into a
// neighbour. When a third handler folder needs them, extract a
// `shared/http/validation.ts`.

import type { MediaOwnerType } from '../../shared/adapters/storage/StorageGateway.js';

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OWNER_TYPES: readonly MediaOwnerType[] = ['BUSINESS', 'STAFF', 'USER'];

/** S3 keys are bounded to 1024 bytes; we use that as our upper limit. */
const STORAGE_KEY_MAX = 1024;

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

export function parseOwnerType(value: unknown): MediaOwnerType {
    if (typeof value !== 'string' || !OWNER_TYPES.includes(value as MediaOwnerType)) {
        throw new ValidationFailure(
            `ownerType must be one of ${OWNER_TYPES.join(', ')}.`,
            { field: 'ownerType', allowed: OWNER_TYPES },
        );
    }
    return value as MediaOwnerType;
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

export function parseOptionalNonNegInt(value: unknown, field: string): number | undefined {
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

export function parseStorageKey(value: unknown): string {
    return parseRequiredString(value, 'storageKey', STORAGE_KEY_MAX);
}
