// EthioLink — media repository.
//
// SQL access to the `media_assets` table. Append-only (the schema doc
// deliberately omits `updated_at` and uses `deleted_at` for soft-delete
// — replacing a photo means inserting a new row and soft-deleting the
// old one).
//
// `owner_id` is a *logical* foreign key validated by `mediaService`:
// the referenced table varies with `owner_type`. The service consults
// the appropriate domain repository before calling `insert` here.

import { BaseRepository } from '../../repositories/baseRepository.js';
import type { MediaOwnerType } from '../../adapters/storage/StorageGateway.js';

/** Domain shape of a `media_assets` row. */
export interface MediaAsset {
    readonly id: string;
    readonly ownerType: MediaOwnerType;
    readonly ownerId: string;
    readonly s3Key: string;
    readonly contentType: string | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly isPublic: boolean;
    readonly createdAt: Date;
    readonly deletedAt: Date | null;
}

/** Fields the service hands to `insert` when confirming an upload. */
export interface InsertMediaInput {
    readonly ownerType: MediaOwnerType;
    readonly ownerId: string;
    readonly s3Key: string;
    readonly contentType: string;
    readonly width?: number | null;
    readonly height?: number | null;
    readonly isPublic: boolean;
}

export interface MediaRepository {
    insert(input: InsertMediaInput): Promise<MediaAsset>;
    findById(id: string): Promise<MediaAsset | null>;
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface MediaRow {
    id: string;
    owner_type: MediaOwnerType;
    owner_id: string;
    s3_key: string;
    content_type: string | null;
    width: number | null;
    height: number | null;
    is_public: boolean;
    created_at: Date;
    deleted_at: Date | null;
}

const MEDIA_COLUMNS =
    'id, owner_type, owner_id, s3_key, content_type, width, height, is_public, created_at, deleted_at';

export class PgMediaRepository extends BaseRepository implements MediaRepository {
    async insert(input: InsertMediaInput): Promise<MediaAsset> {
        const row = await this.one<MediaRow>(
            `
            INSERT INTO media_assets (
                owner_type, owner_id, s3_key,
                content_type, width, height, is_public
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING ${MEDIA_COLUMNS};
            `,
            [
                input.ownerType,
                input.ownerId,
                input.s3Key,
                input.contentType,
                input.width ?? null,
                input.height ?? null,
                input.isPublic,
            ],
        );
        return mapRow(row);
    }

    async findById(id: string): Promise<MediaAsset | null> {
        const row = await this.oneOrNone<MediaRow>(
            `SELECT ${MEDIA_COLUMNS} FROM media_assets WHERE id = $1;`,
            [id],
        );
        return row ? mapRow(row) : null;
    }
}

function mapRow(row: MediaRow): MediaAsset {
    return Object.freeze<MediaAsset>({
        id: row.id,
        ownerType: row.owner_type,
        ownerId: row.owner_id,
        s3Key: row.s3_key,
        contentType: row.content_type,
        width: row.width,
        height: row.height,
        isPublic: row.is_public,
        createdAt: row.created_at,
        deletedAt: row.deleted_at,
    });
}
