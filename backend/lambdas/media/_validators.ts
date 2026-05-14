// EthioLink — media-specific request-body validators.
//
// Generic helpers live in `backend/shared/http/validation.ts` since
// Phase 3; this file keeps only the validators that need media-domain
// types or constants, and re-exports the generic helpers so existing
// handler imports do not need to change.

import type { MediaOwnerType } from '../../shared/adapters/storage/StorageGateway.js';
import {
    ValidationFailure,
    parseJsonObjectBody,
    parseOptionalNonNegInt,
    parseOptionalString,
    parseRequiredString,
    parseRequiredUuid,
} from '../../shared/http/validation.js';

export {
    ValidationFailure,
    parseJsonObjectBody,
    parseOptionalNonNegInt,
    parseOptionalString,
    parseRequiredString,
    parseRequiredUuid,
};

const OWNER_TYPES: readonly MediaOwnerType[] = ['BUSINESS', 'STAFF', 'USER'];

/** S3 keys are bounded to 1024 bytes; we use that as our upper limit. */
const STORAGE_KEY_MAX = 1024;

export function parseOwnerType(value: unknown): MediaOwnerType {
    if (typeof value !== 'string' || !OWNER_TYPES.includes(value as MediaOwnerType)) {
        throw new ValidationFailure(
            `ownerType must be one of ${OWNER_TYPES.join(', ')}.`,
            { field: 'ownerType', allowed: OWNER_TYPES },
        );
    }
    return value as MediaOwnerType;
}

export function parseStorageKey(value: unknown): string {
    return parseRequiredString(value, 'storageKey', STORAGE_KEY_MAX);
}
