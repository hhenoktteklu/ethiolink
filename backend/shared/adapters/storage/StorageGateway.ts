// EthioLink — storage adapter interface.
//
// The service layer talks to media uploads exclusively through this
// interface. The S3-backed implementation (`S3StorageGateway`) lands in
// the next commit; other implementations (Cloudflare R2, GCS, a
// local-disk dev fake) plug in here without changing domain code.
//
// Per the project rule in SYSTEM_ARCHITECTURE.md: "The service layer
// never imports the AWS SDK directly. Adapters in
// `backend/shared/adapters/` wrap AWS-specific work." This file is the
// auth-side analogue of `AuthProvider.ts` — pure types, no AWS imports.
//
// Phase 2 scope: presigned PUT URLs only. Presigned GETs (for serving
// private media) and object deletion are deferred until they're needed
// — keeping the surface narrow until a real call site forces growth.

/**
 * What kind of entity owns a media asset. Mirrors the `owner_type`
 * CHECK constraint in `media_assets`. Kept on the adapter so callers
 * never have to invent the string.
 */
export type MediaOwnerType = 'BUSINESS' | 'STAFF' | 'USER';

/**
 * Inputs accepted by `issueUploadUrl`. Owner identification + content
 * type are the minimum any storage backend needs; `fileExtension` and
 * `isPublic` are hints the backend may honor.
 */
export interface IssueUploadUrlInput {
    /** Which entity owns the file (BUSINESS, STAFF, USER). */
    readonly ownerType: MediaOwnerType;

    /** UUID of the owning entity. The gateway validates the format; existence is the service's job. */
    readonly ownerId: string;

    /** MIME content type the client will PUT, e.g. `image/jpeg`. */
    readonly contentType: string;

    /**
     * Optional filename-extension hint. If present, the gateway MAY embed
     * it in the generated key for nicer browser-visible filenames; if
     * absent, the gateway may derive one from `contentType` or omit the
     * extension entirely.
     */
    readonly fileExtension?: string;

    /**
     * Whether the resulting object should be public-readable once
     * uploaded. Maps to `media_assets.is_public`. The storage layer uses
     * this to choose a target bucket / object ACL — public-readable
     * objects typically go to a public CDN-fronted bucket; private
     * objects go to a bucket served via presigned GETs.
     *
     * Defaults to `false` when omitted.
     */
    readonly isPublic?: boolean;
}

/**
 * Outputs returned by `issueUploadUrl`. The caller passes `uploadUrl`
 * to the client; the client PUTs bytes to it with `requiredHeaders`;
 * the caller later confirms the upload by persisting `storageKey` in
 * `media_assets.s3_key`.
 */
export interface IssueUploadUrlResult {
    /** The URL the client MUST PUT bytes to. Single-use; expires by `expiresAt`. */
    readonly uploadUrl: string;

    /**
     * Stable storage-side key. Persist as `media_assets.s3_key` on
     * confirmation. The column name keeps "s3" for historical reasons,
     * but the value is opaque to the database — a future GCS gateway
     * would put GCS object names here.
     */
    readonly storageKey: string;

    /** ISO-8601 timestamp at which the URL stops working. */
    readonly expiresAt: string;

    /**
     * Headers the client MUST include on the PUT for the URL to be
     * honored. For S3 presigned URLs this typically includes
     * `Content-Type` so the server-side signature matches. Empty object
     * if the gateway requires no specific headers.
     */
    readonly requiredHeaders: Record<string, string>;
}

/**
 * Base class for storage adapter failures. Distinct from generic
 * `Error` so the handler layer can map storage failures to 500
 * INTERNAL_ERROR cleanly without confusing them with domain errors.
 */
export class StorageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StorageError';
    }
}

export interface StorageGateway {
    /**
     * Issue a presigned URL the client can use to upload a single object.
     *
     * Content-type validation against an allowlist is the media-service
     * layer's responsibility; this method does not pass judgment on the
     * MIME type beyond storing it for use in signing. Backend-specific
     * limitations (e.g. an S3 bucket that rejects a content type by
     * policy) surface as `StorageError`.
     *
     * @throws StorageError on infrastructure-level failures (network,
     *         credentials, bucket configuration).
     */
    issueUploadUrl(input: IssueUploadUrlInput): Promise<IssueUploadUrlResult>;
}
