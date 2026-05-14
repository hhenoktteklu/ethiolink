// EthioLink — public JSON shape for a media asset.
//
// Returned by upload-confirm responses and by future listing endpoints
// (Phase 3+). Omits `deletedAt` because soft-deleted rows are filtered
// at the repository layer before reaching the view; surfacing the
// field would be a noise vector with no consumer.
//
// `s3Key` is exposed so clients can construct public CDN URLs (for
// `isPublic = true` media); private media needs a presigned GET issued
// by a future endpoint.

import type { MediaOwnerType } from '../../adapters/storage/StorageGateway.js';

import type { MediaAsset } from './mediaRepository.js';

export interface MediaView {
    readonly id: string;
    readonly ownerType: MediaOwnerType;
    readonly ownerId: string;
    readonly s3Key: string;
    readonly contentType: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly isPublic: boolean;
    readonly createdAt: string;
}

export function toMediaView(media: MediaAsset): MediaView {
    return Object.freeze<MediaView>({
        id: media.id,
        ownerType: media.ownerType,
        ownerId: media.ownerId,
        s3Key: media.s3Key,
        contentType: media.contentType,
        width: media.width,
        height: media.height,
        isPublic: media.isPublic,
        createdAt: media.createdAt.toISOString(),
    });
}
