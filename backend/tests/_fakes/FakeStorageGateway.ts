// EthioLink — in-test `StorageGateway` fake.
//
// Captures every `issueUploadUrl` call so tests can assert on the
// inputs the service passed (most importantly, the `isPublic` flag
// derived from `ownerType` and whether `fileExtension` was forwarded).
// Returns a deterministic key shaped exactly like
// `S3StorageGateway` would issue: `<ownerType-lowercase>/<ownerId>/<token>.<ext>`.
//
// The fake does NOT validate inputs — it's just a recorder. Validation
// is `MediaService`'s job; the gateway is the outermost adapter.

import {
    type IssueUploadUrlInput,
    type IssueUploadUrlResult,
    type StorageGateway,
} from '../../shared/adapters/storage/StorageGateway.js';

const EXT_FROM_CONTENT_TYPE: Readonly<Record<string, string>> = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
});

export class FakeStorageGateway implements StorageGateway {
    /** Every call's input, in chronological order. */
    public readonly calls: IssueUploadUrlInput[] = [];

    /** Snapshot of the most recent call, or `undefined` if not called. */
    lastCall(): IssueUploadUrlInput | undefined {
        return this.calls[this.calls.length - 1];
    }

    /** Reset the call log between subtests if needed. */
    reset(): void {
        this.calls.length = 0;
    }

    async issueUploadUrl(input: IssueUploadUrlInput): Promise<IssueUploadUrlResult> {
        // Freeze the captured copy so tests can't accidentally mutate it.
        this.calls.push(Object.freeze({ ...input }));

        const ext =
            input.fileExtension ??
            EXT_FROM_CONTENT_TYPE[input.contentType.toLowerCase()] ??
            null;
        const tokenSuffix = `${this.calls.length.toString().padStart(4, '0')}`;
        const base = `${input.ownerType.toLowerCase()}/${input.ownerId}/test-${tokenSuffix}`;
        const storageKey = ext ? `${base}.${ext}` : base;

        return Object.freeze<IssueUploadUrlResult>({
            uploadUrl: `https://example.invalid/upload/${storageKey}`,
            storageKey,
            expiresAt: '2099-01-01T00:00:00.000Z',
            requiredHeaders: Object.freeze({ 'Content-Type': input.contentType }),
        });
    }
}
