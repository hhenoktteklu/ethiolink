// EthioLink — MediaService unit tests.
//
// Covers the Phase 2 policy that lives in `mediaService.ts`:
//
//   * Content-type allowlist (`image/jpeg`, `image/png`, `image/webp`).
//   * Ownership matrix:
//     - BUSINESS → caller must own the business
//     - USER     → `ownerId` must equal `callerUserId`
//     - STAFF    → deferred to Phase 3 (explicit error)
//   * `isPublic` derivation (BUSINESS → true, USER → false) and that
//     the value is NOT client-controlled.
//   * `fileExtension` forwarded to the storage gateway when provided.
//   * `confirmUpload` happy path persists the row.
//   * `confirmUpload` storage-key prefix check (security control).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Business } from '../../shared/domains/businesses/businessRepository.js';
import {
    MediaContentTypeNotAllowedError,
    MediaNotOwnedError,
    MediaOwnerNotFoundError,
    MediaService,
    MediaStorageKeyMismatchError,
} from '../../shared/domains/media/mediaService.js';

import { InMemoryBusinessRepository } from '../_fakes/InMemoryBusinessRepository.js';
import { InMemoryMediaRepository } from '../_fakes/InMemoryMediaRepository.js';
import { InMemoryStaffRepository } from '../_fakes/InMemoryStaffRepository.js';
import { FakeStorageGateway } from '../_fakes/FakeStorageGateway.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const OWNER_A = '11111111-1111-1111-1111-111111111111';
const OWNER_B = '22222222-2222-2222-2222-222222222222';
const BIZ_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BIZ_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const STAFF_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeBusiness(overrides: Partial<Business> = {}): Business {
    const now = new Date('2026-05-14T12:00:00.000Z');
    return Object.freeze({
        id: BIZ_A,
        ownerUserId: OWNER_A,
        categoryId: '99999999-9999-9999-9999-999999999999',
        name: 'Test Salon',
        description: { en: 'A test salon.' },
        city: 'Addis Ababa',
        addressLine: null,
        latitude: null,
        longitude: null,
        phone: null,
        telegramHandle: null,
        whatsappPhone: null,
        status: 'APPROVED' as const,
        featuredUntil: null,
        ratingAvg: 0,
        ratingCount: 0,
        createdAt: now,
        updatedAt: now,
        // Phase 9 Track 6 added `searchRank` as a required `number |
        // null` field on `Business`; default to `null` here so the
        // factory stays compatible.
        searchRank: null,
        ...overrides,
    });
}

function build(): {
    service: MediaService;
    mediaRepo: InMemoryMediaRepository;
    businessRepo: InMemoryBusinessRepository;
    staffRepo: InMemoryStaffRepository;
    gateway: FakeStorageGateway;
} {
    const mediaRepo = new InMemoryMediaRepository();
    const businessRepo = new InMemoryBusinessRepository();
    const staffRepo = new InMemoryStaffRepository();
    const gateway = new FakeStorageGateway();
    const service = new MediaService(mediaRepo, businessRepo, staffRepo, gateway);
    return { service, mediaRepo, businessRepo, staffRepo, gateway };
}

// ---------------------------------------------------------------------------
// Content-type allowlist
// ---------------------------------------------------------------------------

describe('MediaService.issueUploadUrl — content type allowlist', () => {
    for (const ct of ['image/jpeg', 'image/png', 'image/webp']) {
        it(`accepts ${ct}`, async () => {
            const { service, businessRepo } = build();
            businessRepo.seed(makeBusiness());

            const result = await service.issueUploadUrl(OWNER_A, {
                ownerType: 'BUSINESS',
                ownerId: BIZ_A,
                contentType: ct,
            });

            assert.ok(result.uploadUrl.startsWith('https://'));
            assert.ok(result.storageKey.startsWith(`business/${BIZ_A}/`));
        });
    }

    for (const ct of ['image/gif', 'application/pdf', 'video/mp4', 'text/plain']) {
        it(`rejects ${ct}`, async () => {
            const { service, businessRepo } = build();
            businessRepo.seed(makeBusiness());

            await assert.rejects(
                () =>
                    service.issueUploadUrl(OWNER_A, {
                        ownerType: 'BUSINESS',
                        ownerId: BIZ_A,
                        contentType: ct,
                    }),
                (err: unknown) =>
                    err instanceof MediaContentTypeNotAllowedError &&
                    err.contentType === ct,
            );
        });
    }
});

// ---------------------------------------------------------------------------
// Ownership matrix — BUSINESS
// ---------------------------------------------------------------------------

describe('MediaService.issueUploadUrl — ownership: BUSINESS', () => {
    it('owner can issue an upload URL for their business', async () => {
        const { service, businessRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        const result = await service.issueUploadUrl(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(gateway.calls.length, 1);
        assert.strictEqual(gateway.lastCall()?.ownerId, BIZ_A);
        assert.ok(result.storageKey.startsWith(`business/${BIZ_A}/`));
    });

    it('non-owner is rejected with MediaNotOwnedError', async () => {
        const { service, businessRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        await assert.rejects(
            () =>
                service.issueUploadUrl(OWNER_B, {
                    ownerType: 'BUSINESS',
                    ownerId: BIZ_A,
                    contentType: 'image/jpeg',
                }),
            MediaNotOwnedError,
        );
        assert.strictEqual(gateway.calls.length, 0, 'gateway not called on auth failure');
    });

    it('unknown business id returns MediaOwnerNotFoundError', async () => {
        const { service } = build();

        await assert.rejects(
            () =>
                service.issueUploadUrl(OWNER_A, {
                    ownerType: 'BUSINESS',
                    ownerId: BIZ_A,
                    contentType: 'image/jpeg',
                }),
            (err: unknown) =>
                err instanceof MediaOwnerNotFoundError &&
                err.ownerType === 'BUSINESS' &&
                err.ownerId === BIZ_A,
        );
    });
});

// ---------------------------------------------------------------------------
// Ownership matrix — USER
// ---------------------------------------------------------------------------

describe('MediaService.issueUploadUrl — ownership: USER', () => {
    it('caller can issue an upload URL for self', async () => {
        const { service, gateway } = build();

        const result = await service.issueUploadUrl(OWNER_A, {
            ownerType: 'USER',
            ownerId: OWNER_A,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(gateway.calls.length, 1);
        assert.ok(result.storageKey.startsWith(`user/${OWNER_A}/`));
    });

    it('caller cannot issue for another user', async () => {
        const { service, gateway } = build();

        await assert.rejects(
            () =>
                service.issueUploadUrl(OWNER_A, {
                    ownerType: 'USER',
                    ownerId: OWNER_B,
                    contentType: 'image/jpeg',
                }),
            MediaNotOwnedError,
        );
        assert.strictEqual(gateway.calls.length, 0);
    });
});

// ---------------------------------------------------------------------------
// Ownership matrix — STAFF (deferred)
// ---------------------------------------------------------------------------

describe('MediaService.issueUploadUrl — ownership: STAFF', () => {
    it('owner-of-business can issue an upload URL for one of its staff', async () => {
        const { service, businessRepo, staffRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));
        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });

        const result = await service.issueUploadUrl(OWNER_A, {
            ownerType: 'STAFF',
            ownerId: staff.id,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(gateway.calls.length, 1);
        assert.strictEqual(gateway.lastCall()?.ownerId, staff.id);
        assert.ok(result.storageKey.startsWith(`staff/${staff.id}/`));
    });

    it('passes isPublic=true for STAFF (gallery photos go to the public bucket)', async () => {
        const { service, businessRepo, staffRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));
        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });

        await service.issueUploadUrl(OWNER_A, {
            ownerType: 'STAFF',
            ownerId: staff.id,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(gateway.lastCall()?.isPublic, true);
    });

    it('non-owner is rejected with MediaNotOwnedError', async () => {
        const { service, businessRepo, staffRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));
        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });

        await assert.rejects(
            () =>
                service.issueUploadUrl(OWNER_B, {
                    ownerType: 'STAFF',
                    ownerId: staff.id,
                    contentType: 'image/jpeg',
                }),
            MediaNotOwnedError,
        );
        assert.strictEqual(gateway.calls.length, 0, 'gateway not called on auth failure');
    });

    it('unknown staff id returns MediaOwnerNotFoundError', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        await assert.rejects(
            () =>
                service.issueUploadUrl(OWNER_A, {
                    ownerType: 'STAFF',
                    ownerId: STAFF_ID,
                    contentType: 'image/jpeg',
                }),
            (err: unknown) =>
                err instanceof MediaOwnerNotFoundError &&
                err.ownerType === 'STAFF' &&
                err.ownerId === STAFF_ID,
        );
    });
});

// ---------------------------------------------------------------------------
// isPublic derivation
// ---------------------------------------------------------------------------

describe('MediaService.issueUploadUrl — isPublic derivation', () => {
    it('passes isPublic=true for BUSINESS', async () => {
        const { service, businessRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        await service.issueUploadUrl(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(gateway.lastCall()?.isPublic, true);
    });

    it('passes isPublic=false for USER', async () => {
        const { service, gateway } = build();

        await service.issueUploadUrl(OWNER_A, {
            ownerType: 'USER',
            ownerId: OWNER_A,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(gateway.lastCall()?.isPublic, false);
    });
});

// ---------------------------------------------------------------------------
// fileExtension forwarding
// ---------------------------------------------------------------------------

describe('MediaService.issueUploadUrl — fileExtension forwarding', () => {
    it('forwards fileExtension when provided', async () => {
        const { service, businessRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        await service.issueUploadUrl(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            contentType: 'image/jpeg',
            fileExtension: 'jpeg',
        });

        assert.strictEqual(gateway.lastCall()?.fileExtension, 'jpeg');
    });

    it('omits fileExtension when not provided', async () => {
        const { service, businessRepo, gateway } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        await service.issueUploadUrl(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(gateway.lastCall()?.fileExtension, undefined);
    });
});

// ---------------------------------------------------------------------------
// confirmUpload — happy path + auth + prefix check
// ---------------------------------------------------------------------------

describe('MediaService.confirmUpload', () => {
    it('persists a media_assets row on the happy path', async () => {
        const { service, mediaRepo, businessRepo } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        // Step 1: issue an upload URL so we have a valid storageKey.
        const issued = await service.issueUploadUrl(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            contentType: 'image/jpeg',
        });

        // Step 2: confirm.
        const asset = await service.confirmUpload(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            storageKey: issued.storageKey,
            contentType: 'image/jpeg',
            width: 1024,
            height: 768,
        });

        assert.strictEqual(asset.ownerType, 'BUSINESS');
        assert.strictEqual(asset.ownerId, BIZ_A);
        assert.strictEqual(asset.s3Key, issued.storageKey);
        assert.strictEqual(asset.contentType, 'image/jpeg');
        assert.strictEqual(asset.width, 1024);
        assert.strictEqual(asset.height, 768);
        assert.strictEqual(asset.isPublic, true);
        assert.strictEqual(asset.deletedAt, null);
        assert.strictEqual(mediaRepo.size(), 1);
    });

    it('rejects a storage key that does not start with the owner prefix', async () => {
        const { service, mediaRepo, businessRepo } = build();
        // Alice owns BIZ_A.
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));
        // Eve owns BIZ_B.
        businessRepo.seed(
            makeBusiness({ id: BIZ_B, ownerUserId: OWNER_B }),
        );

        // Step 1: Alice issues a URL for HER business — generates a key
        //         prefixed with `business/<BIZ_A>/...`.
        const issuedForAlice = await service.issueUploadUrl(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            contentType: 'image/jpeg',
        });

        // Step 2: Eve (who owns BIZ_B) tries to claim Alice's key
        //         as belonging to her business B. Ownership check
        //         alone would pass (she owns BIZ_B), but the prefix
        //         check catches the mismatch.
        await assert.rejects(
            () =>
                service.confirmUpload(OWNER_B, {
                    ownerType: 'BUSINESS',
                    ownerId: BIZ_B,
                    storageKey: issuedForAlice.storageKey,
                    contentType: 'image/jpeg',
                }),
            MediaStorageKeyMismatchError,
        );
        assert.strictEqual(mediaRepo.size(), 0, 'no row written on prefix mismatch');
    });

    it('rejects non-owner even with a well-formed key', async () => {
        const { service, mediaRepo, businessRepo } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        const issued = await service.issueUploadUrl(OWNER_A, {
            ownerType: 'BUSINESS',
            ownerId: BIZ_A,
            contentType: 'image/jpeg',
        });

        await assert.rejects(
            () =>
                service.confirmUpload(OWNER_B, {
                    ownerType: 'BUSINESS',
                    ownerId: BIZ_A,
                    storageKey: issued.storageKey,
                    contentType: 'image/jpeg',
                }),
            MediaNotOwnedError,
        );
        assert.strictEqual(mediaRepo.size(), 0);
    });

    it('rejects disallowed content type', async () => {
        const { service, businessRepo } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));

        await assert.rejects(
            () =>
                service.confirmUpload(OWNER_A, {
                    ownerType: 'BUSINESS',
                    ownerId: BIZ_A,
                    storageKey: `business/${BIZ_A}/anything.gif`,
                    contentType: 'image/gif',
                }),
            MediaContentTypeNotAllowedError,
        );
    });

    it('persists a STAFF media row when the caller owns the staff member\'s business', async () => {
        const { service, mediaRepo, businessRepo, staffRepo } = build();
        businessRepo.seed(makeBusiness({ id: BIZ_A, ownerUserId: OWNER_A }));
        const staff = await staffRepo.insert({
            businessId: BIZ_A,
            displayName: 'Helen',
            role: null,
        });

        const issued = await service.issueUploadUrl(OWNER_A, {
            ownerType: 'STAFF',
            ownerId: staff.id,
            contentType: 'image/jpeg',
        });

        const asset = await service.confirmUpload(OWNER_A, {
            ownerType: 'STAFF',
            ownerId: staff.id,
            storageKey: issued.storageKey,
            contentType: 'image/jpeg',
        });

        assert.strictEqual(asset.ownerType, 'STAFF');
        assert.strictEqual(asset.ownerId, staff.id);
        // STAFF media goes to the public bucket (defaultIsPublic).
        assert.strictEqual(asset.isPublic, true);
        assert.strictEqual(mediaRepo.size(), 1);
    });
});
