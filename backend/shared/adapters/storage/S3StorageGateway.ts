// EthioLink — S3-backed StorageGateway.
//
// Issues presigned PUT URLs against either the public or the private
// media bucket, chosen by `IssueUploadUrlInput.isPublic`. The bucket
// names and URL lifetime come from `AppConfig.s3`; the region comes
// from `AppConfig.region`.
//
// Key shape: `<ownerType-lowercase>/<ownerId>/<uuid>.<ext>`. The
// ownerId prefix keeps per-owner listing cheap; the random UUID keeps
// keys collision-free across concurrent uploads; the optional
// extension makes browser-visible filenames pleasant.
//
// Only this file imports the AWS SDK. The service-layer and handler
// code talk to `StorageGateway` (the interface), not to anything in
// `@aws-sdk/*`.

import { randomUUID } from 'node:crypto';

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3Config } from '../../config/loadConfig.js';

import {
    StorageError,
    type IssueUploadUrlInput,
    type IssueUploadUrlResult,
    type StorageGateway,
} from './StorageGateway.js';

/**
 * Fallback extension lookup, used when `IssueUploadUrlInput.fileExtension`
 * is absent. Intentionally short — service-layer code is responsible for
 * enforcing an allowlist of acceptable content types; this map only
 * decides what the file is named afterwards.
 */
const EXTENSION_FROM_CONTENT_TYPE: Readonly<Record<string, string>> = Object.freeze({
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'application/pdf': 'pdf',
});

const SAFE_EXTENSION_RE = /^[a-z0-9]{1,8}$/;

export class S3StorageGateway implements StorageGateway {
    private readonly client: S3Client;
    private readonly s3: S3Config;

    constructor(s3Config: S3Config, region: string) {
        if (!s3Config.publicBucket) {
            throw new StorageError(
                'S3StorageGateway requires S3_BUCKET_MEDIA_PUBLIC to be set.',
            );
        }
        if (!s3Config.privateBucket) {
            throw new StorageError(
                'S3StorageGateway requires S3_BUCKET_MEDIA_PRIVATE to be set.',
            );
        }
        if (s3Config.uploadUrlExpiresSeconds <= 0) {
            throw new StorageError(
                'S3_UPLOAD_URL_EXPIRES_SECONDS must be a positive integer.',
            );
        }
        this.s3 = s3Config;
        this.client = new S3Client({ region });
    }

    async issueUploadUrl(input: IssueUploadUrlInput): Promise<IssueUploadUrlResult> {
        const isPublic = input.isPublic === true;
        const bucket = isPublic ? this.s3.publicBucket : this.s3.privateBucket;
        const extension = pickExtension(input);
        const storageKey = buildKey(input.ownerType, input.ownerId, extension);

        const command = new PutObjectCommand({
            Bucket: bucket,
            Key: storageKey,
            ContentType: input.contentType,
        });

        let uploadUrl: string;
        try {
            uploadUrl = await getSignedUrl(this.client, command, {
                expiresIn: this.s3.uploadUrlExpiresSeconds,
            });
        } catch (err) {
            throw new StorageError(
                err instanceof Error
                    ? `Failed to sign upload URL: ${err.message}`
                    : 'Failed to sign upload URL.',
            );
        }

        const expiresAt = new Date(
            Date.now() + this.s3.uploadUrlExpiresSeconds * 1000,
        ).toISOString();

        return Object.freeze<IssueUploadUrlResult>({
            uploadUrl,
            storageKey,
            expiresAt,
            requiredHeaders: Object.freeze({ 'Content-Type': input.contentType }),
        });
    }
}

// ---------------------------------------------------------------------------
// Key construction helpers
// ---------------------------------------------------------------------------

function pickExtension(input: IssueUploadUrlInput): string | null {
    const hint = input.fileExtension?.trim().replace(/^\./, '').toLowerCase();
    if (hint && SAFE_EXTENSION_RE.test(hint)) {
        return hint;
    }
    const mapped = EXTENSION_FROM_CONTENT_TYPE[input.contentType.trim().toLowerCase()];
    return mapped ?? null;
}

function buildKey(ownerType: string, ownerId: string, ext: string | null): string {
    const base = `${ownerType.toLowerCase()}/${ownerId}/${randomUUID()}`;
    return ext ? `${base}.${ext}` : base;
}
