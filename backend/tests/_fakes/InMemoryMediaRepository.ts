// EthioLink — in-memory `MediaRepository` for tests.
//
// `media_assets` is append-only: production `insert` is the only write
// path, and `findById` is the only read. The fake mirrors that surface.
// `deletedAt` is always written as `null` here; the production code path
// doesn't soft-delete on insert either.

import { randomUUID } from 'node:crypto';

import type {
    InsertMediaInput,
    MediaAsset,
    MediaRepository,
} from '../../shared/domains/media/mediaRepository.js';

export class InMemoryMediaRepository implements MediaRepository {
    private readonly rowsById = new Map<string, MediaAsset>();

    /** Test helper: total rows stored. */
    size(): number {
        return this.rowsById.size;
    }

    /** Test helper: snapshot of inserted rows in insertion order. */
    all(): readonly MediaAsset[] {
        return [...this.rowsById.values()];
    }

    async insert(input: InsertMediaInput): Promise<MediaAsset> {
        const asset: MediaAsset = Object.freeze({
            id: randomUUID(),
            ownerType: input.ownerType,
            ownerId: input.ownerId,
            s3Key: input.s3Key,
            contentType: input.contentType,
            width: input.width ?? null,
            height: input.height ?? null,
            isPublic: input.isPublic,
            createdAt: new Date(),
            deletedAt: null,
        });
        this.rowsById.set(asset.id, asset);
        return asset;
    }

    async findById(id: string): Promise<MediaAsset | null> {
        return this.rowsById.get(id) ?? null;
    }
}
