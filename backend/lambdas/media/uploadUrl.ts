// EthioLink — Lambda handler for `POST /v1/media/upload-url`.
//
// Authenticated. No handler-level role check — owner-row-level
// authorization is enforced inside `MediaService` based on
// `(ownerType, ownerId)`. A CUSTOMER uploading their own avatar
// (`ownerType=USER`, `ownerId=their own users.id`) is legitimate;
// a BUSINESS_OWNER uploading to their own business is legitimate;
// the service rejects anything else.
//
// Returns the gateway shape flat:
//
//   {
//     "uploadUrl": "https://...",
//     "storageKey": "business/<id>/<uuid>.jpg",
//     "expiresAt": "2026-05-14T...",
//     "requiredHeaders": { "Content-Type": "image/jpeg" }
//   }
//
// Service errors → HTTP:
//   * MediaContentTypeNotAllowedError    → 400 with details.allowed[]
//   * MediaUnsupportedOwnerTypeError     → 400 with details.ownerType
//   * MediaOwnerNotFoundError            → 404
//   * MediaNotOwnedError                 → 403
//   * StorageError                       → 500 (logged; message not leaked)

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { S3StorageGateway } from '../../shared/adapters/storage/S3StorageGateway.js';
import { StorageError } from '../../shared/adapters/storage/StorageGateway.js';
import { loadConfig } from '../../shared/config/loadConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import {
    MediaContentTypeNotAllowedError,
    MediaNotOwnedError,
    MediaOwnerNotFoundError,
    MediaService,
    MediaUnsupportedOwnerTypeError,
    type IssueUploadUrlServiceInput,
} from '../../shared/domains/media/mediaService.js';
import { PgMediaRepository } from '../../shared/domains/media/mediaRepository.js';
import { PgUserRepository } from '../../shared/domains/users/userRepository.js';
import { UserService } from '../../shared/domains/users/userService.js';
import { extractPrincipal } from '../../shared/http/principal.js';
import {
    forbidden,
    internalError,
    notFound,
    ok,
    unauthenticated,
    validationError,
} from '../../shared/http/responses.js';
import { createLogger } from '../../shared/logging/logger.js';

import {
    parseJsonObjectBody,
    parseOptionalString,
    parseOwnerType,
    parseRequiredString,
    parseRequiredUuid,
    ValidationFailure,
} from './_validators.js';

// Cold-start init. S3StorageGateway throws here if S3 buckets are
// unset — these handlers cannot function without them, so failing
// loudly at module load is the correct behaviour.
const config = loadConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const storage = new S3StorageGateway(config.s3, config.region);
const mediaService = new MediaService(
    new PgMediaRepository(pool),
    new PgBusinessRepository(pool),
    storage,
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'media.uploadUrl',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let input: IssueUploadUrlServiceInput;
        try {
            input = parseIssueUploadUrlBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const result = await mediaService.issueUploadUrl(user.id, input);
            return ok({
                uploadUrl: result.uploadUrl,
                storageKey: result.storageKey,
                expiresAt: result.expiresAt,
                requiredHeaders: result.requiredHeaders,
            });
        } catch (err) {
            if (err instanceof MediaContentTypeNotAllowedError) {
                return validationError(err.message, {
                    field: 'contentType',
                    allowed: err.allowed,
                });
            }
            if (err instanceof MediaUnsupportedOwnerTypeError) {
                return validationError(err.message, {
                    field: 'ownerType',
                    ownerType: err.ownerType,
                });
            }
            if (err instanceof MediaOwnerNotFoundError) {
                return notFound(err.message);
            }
            if (err instanceof MediaNotOwnedError) {
                return forbidden(err.message);
            }
            if (err instanceof StorageError) {
                logger.error('media.storage.failed', { error: err.message });
                return internalError();
            }
            throw err;
        }
    } catch (err) {
        if (
            err instanceof TokenExpiredError ||
            err instanceof TokenInvalidError ||
            err instanceof ClaimsMalformedError ||
            err instanceof AuthError
        ) {
            logger.warn('auth.unauthenticated', { reason: err.message });
            return unauthenticated(err.message);
        }
        logger.error('media.uploadUrl.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseIssueUploadUrlBody(rawBody: string | null): IssueUploadUrlServiceInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    return {
        ownerType: parseOwnerType(obj.ownerType),
        ownerId: parseRequiredUuid(obj.ownerId, 'ownerId'),
        contentType: parseRequiredString(obj.contentType, 'contentType', 200),
        ...((): { fileExtension?: string } => {
            const ext = parseOptionalString(obj.fileExtension, 'fileExtension', 16);
            return ext === undefined ? {} : { fileExtension: ext };
        })(),
    };
}
