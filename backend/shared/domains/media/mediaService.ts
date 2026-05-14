// EthioLink — media service.
//
// Owns the rules around media uploads:
//
//   * Content-type allowlist (Phase 2 = images only).
//   * Owner-authorization checks. The caller must:
//       - BUSINESS — own the referenced business (`business.ownerUserId`).
//       - STAFF    — own the business the staff member belongs to
//                    (two-hop: staff → business → caller).
//       - USER     — be the referenced user.
//   * `isPublic` defaults — derived from `ownerType`, NOT client-supplied.
//     BUSINESS / STAFF media is public-readable (gallery photos);
//     USER media is private (avatars).
//   * Storage-key prefix verification on confirm, so a caller cannot
//     claim a key that wasn't issued for the owner they're asserting.
//
// Talks to `StorageGateway` (the port), never to the AWS SDK directly.
// Persistence is via `MediaRepository`. Ownership lookups go through
// `BusinessRepository` for BUSINESS media; USER ownership is a direct
// callerUserId === ownerId comparison.

import {
    type IssueUploadUrlInput,
    type IssueUploadUrlResult,
    type MediaOwnerType,
    type StorageGateway,
} from '../../adapters/storage/StorageGateway.js';
import type { BusinessRepository } from '../businesses/businessRepository.js';
import type { StaffRepository } from '../staff/staffRepository.js';

import type { MediaAsset, MediaRepository } from './mediaRepository.js';

/** Phase 2 allowlist of MIME types. Add PDFs / docs when staff certs land in Phase 3. */
export const ALLOWED_CONTENT_TYPES: ReadonlySet<string> = new Set([
    'image/jpeg',
    'image/png',
    'image/webp',
]);

// ---------------------------------------------------------------------------
// Errors — each maps to one HTTP code in handlers
// ---------------------------------------------------------------------------

export class MediaContentTypeNotAllowedError extends Error {
    public readonly contentType: string;
    public readonly allowed: readonly string[];
    constructor(contentType: string) {
        super(`Content type ${contentType} is not allowed.`);
        this.name = 'MediaContentTypeNotAllowedError';
        this.contentType = contentType;
        this.allowed = [...ALLOWED_CONTENT_TYPES];
    }
}

export class MediaOwnerNotFoundError extends Error {
    public readonly ownerType: MediaOwnerType;
    public readonly ownerId: string;
    constructor(ownerType: MediaOwnerType, ownerId: string) {
        super(`Owner not found: ${ownerType}/${ownerId}.`);
        this.name = 'MediaOwnerNotFoundError';
        this.ownerType = ownerType;
        this.ownerId = ownerId;
    }
}

export class MediaNotOwnedError extends Error {
    constructor() {
        super('Caller does not own the referenced media owner.');
        this.name = 'MediaNotOwnedError';
    }
}

/**
 * Raised when an `ownerType` is recognized by the schema but not yet
 * supported by the application. Held in reserve for any future owner
 * type that lands later than its `media_assets.owner_type` CHECK
 * value. As of Phase 3, every supported value (BUSINESS, STAFF, USER)
 * has a working ownership check and this error is no longer thrown by
 * `MediaService`; handlers retain the mapping for forward compatibility.
 */
export class MediaUnsupportedOwnerTypeError extends Error {
    public readonly ownerType: MediaOwnerType;
    constructor(ownerType: MediaOwnerType) {
        super(`Media uploads for ownerType=${ownerType} are not yet supported.`);
        this.name = 'MediaUnsupportedOwnerTypeError';
        this.ownerType = ownerType;
    }
}

export class MediaStorageKeyMismatchError extends Error {
    constructor() {
        super('storageKey does not match the asserted owner.');
        this.name = 'MediaStorageKeyMismatchError';
    }
}

// ---------------------------------------------------------------------------
// Service inputs
// ---------------------------------------------------------------------------

export interface IssueUploadUrlServiceInput {
    readonly ownerType: MediaOwnerType;
    readonly ownerId: string;
    readonly contentType: string;
    readonly fileExtension?: string;
}

export interface ConfirmUploadInput {
    readonly ownerType: MediaOwnerType;
    readonly ownerId: string;
    readonly storageKey: string;
    readonly contentType: string;
    readonly width?: number | null;
    readonly height?: number | null;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class MediaService {
    constructor(
        private readonly mediaRepo: MediaRepository,
        private readonly businessRepo: BusinessRepository,
        private readonly staffRepo: StaffRepository,
        private readonly storage: StorageGateway,
    ) {}

    /**
     * Validate caller + content type, then ask the storage gateway for a
     * presigned PUT URL. The `isPublic` flag is derived here (not
     * client-supplied) per the Phase 2 policy.
     */
    async issueUploadUrl(
        callerUserId: string,
        input: IssueUploadUrlServiceInput,
    ): Promise<IssueUploadUrlResult> {
        this.assertContentTypeAllowed(input.contentType);
        await this.assertOwnership(callerUserId, input.ownerType, input.ownerId);

        const gatewayInput: IssueUploadUrlInput = {
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            contentType: input.contentType,
            isPublic: defaultIsPublic(input.ownerType),
            ...(input.fileExtension !== undefined && { fileExtension: input.fileExtension }),
        };
        return this.storage.issueUploadUrl(gatewayInput);
    }

    /**
     * Persist a `media_assets` row for an upload the client has confirmed
     * via the presigned PUT URL. Re-validates caller + content type and
     * checks that `storageKey` matches the prefix the gateway would have
     * issued for the asserted owner — preventing a caller from claiming
     * a key that wasn't issued to them.
     */
    async confirmUpload(
        callerUserId: string,
        input: ConfirmUploadInput,
    ): Promise<MediaAsset> {
        this.assertContentTypeAllowed(input.contentType);
        await this.assertOwnership(callerUserId, input.ownerType, input.ownerId);
        assertKeyMatchesOwner(input.storageKey, input.ownerType, input.ownerId);

        return this.mediaRepo.insert({
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            s3Key: input.storageKey,
            contentType: input.contentType,
            width: input.width ?? null,
            height: input.height ?? null,
            isPublic: defaultIsPublic(input.ownerType),
        });
    }

    // -- internals -----------------------------------------------------------

    private assertContentTypeAllowed(contentType: string): void {
        const normalized = contentType.trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(normalized)) {
            throw new MediaContentTypeNotAllowedError(contentType);
        }
    }

    private async assertOwnership(
        callerUserId: string,
        ownerType: MediaOwnerType,
        ownerId: string,
    ): Promise<void> {
        switch (ownerType) {
            case 'BUSINESS': {
                const business = await this.businessRepo.findById(ownerId);
                if (!business) {
                    throw new MediaOwnerNotFoundError(ownerType, ownerId);
                }
                if (business.ownerUserId !== callerUserId) {
                    throw new MediaNotOwnedError();
                }
                return;
            }
            case 'STAFF': {
                // Two-hop check: staff → business → caller. The staff
                // member doesn't carry an owner directly; the business
                // they belong to does.
                const staff = await this.staffRepo.findById(ownerId);
                if (!staff) {
                    throw new MediaOwnerNotFoundError(ownerType, ownerId);
                }
                const business = await this.businessRepo.findById(staff.businessId);
                if (!business) {
                    // Schema FK should prevent this; defensive.
                    throw new MediaOwnerNotFoundError(ownerType, ownerId);
                }
                if (business.ownerUserId !== callerUserId) {
                    throw new MediaNotOwnedError();
                }
                return;
            }
            case 'USER': {
                if (ownerId !== callerUserId) {
                    throw new MediaNotOwnedError();
                }
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Phase 2 default visibility per owner type:
 *   - BUSINESS / STAFF media are public-readable (gallery photos).
 *   - USER media is private (avatars).
 *
 * Not client-controlled — the service applies this consistently in both
 * the URL-issue step and the row-persist step. They MUST agree or the
 * stored row's `is_public` flag will be out of sync with which bucket
 * the object actually landed in.
 */
function defaultIsPublic(ownerType: MediaOwnerType): boolean {
    switch (ownerType) {
        case 'BUSINESS':
        case 'STAFF':
            return true;
        case 'USER':
            return false;
    }
}

/**
 * Confirm that `storageKey` begins with `<ownerType-lowercase>/<ownerId>/`,
 * matching the shape `S3StorageGateway` issues. This stops a caller from
 * confirming a key that wasn't actually meant for the owner they're
 * asserting (which would otherwise let an attacker who owns business B
 * claim ownership of Alice's business A photo by passing Alice's key
 * with `ownerId=B`).
 */
function assertKeyMatchesOwner(
    storageKey: string,
    ownerType: MediaOwnerType,
    ownerId: string,
): void {
    const expectedPrefix = `${ownerType.toLowerCase()}/${ownerId}/`;
    if (!storageKey.startsWith(expectedPrefix)) {
        throw new MediaStorageKeyMismatchError();
    }
}
