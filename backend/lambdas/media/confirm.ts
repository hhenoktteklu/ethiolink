// EthioLink — Lambda handler for `POST /v1/media`.
//
// Confirms a successful S3 upload by persisting a `media_assets` row.
// The client passes back the `storageKey` it received from
// `POST /v1/media/upload-url`, along with the same `ownerType` /
// `ownerId` / `contentType` it asserted there. `MediaService` re-runs
// the ownership check and verifies the storage key matches the
// asserted owner — preventing a caller from claiming someone else's
// key with their own owner id.
//
// Authenticated. No handler-level role check (matches uploadUrl).
//
// Service errors → HTTP:
//   * MediaContentTypeNotAllowedError    → 400 with details.allowed[]
//   * MediaUnsupportedOwnerTypeError     → 400 with details.ownerType
//   * MediaStorageKeyMismatchError       → 400 with details.field='storageKey'
//   * MediaOwnerNotFoundError            → 404
//   * MediaNotOwnedError                 → 403

import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

import {
    AuthError,
    ClaimsMalformedError,
    TokenExpiredError,
    TokenInvalidError,
} from '../../shared/adapters/auth/AuthProvider.js';
import { CognitoAuthProvider } from '../../shared/adapters/auth/CognitoAuthProvider.js';
import { loadSecretsThenConfig } from '../../shared/config/loadSecretsThenConfig.js';
import { getPool } from '../../shared/db/pgClient.js';
import { PgBusinessRepository } from '../../shared/domains/businesses/businessRepository.js';
import {
    MediaContentTypeNotAllowedError,
    MediaNotOwnedError,
    MediaOwnerNotFoundError,
    MediaService,
    MediaStorageKeyMismatchError,
    MediaUnsupportedOwnerTypeError,
    type ConfirmUploadInput,
} from '../../shared/domains/media/mediaService.js';
import { PgMediaRepository } from '../../shared/domains/media/mediaRepository.js';
import { toMediaView } from '../../shared/domains/media/mediaView.js';
import { S3StorageGateway } from '../../shared/adapters/storage/S3StorageGateway.js';
import { PgStaffRepository } from '../../shared/domains/staff/staffRepository.js';
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
    parseOptionalNonNegInt,
    parseOwnerType,
    parseRequiredString,
    parseRequiredUuid,
    parseStorageKey,
    ValidationFailure,
} from './_validators.js';

const config = await loadSecretsThenConfig();
const baseLogger = createLogger({ level: config.logLevel });
const authProvider = new CognitoAuthProvider(config.cognito);
const pool = getPool(config);
const userService = new UserService(new PgUserRepository(pool));
const mediaService = new MediaService(
    new PgMediaRepository(pool),
    new PgBusinessRepository(pool),
    new PgStaffRepository(pool),
    new S3StorageGateway(config.s3, config.region),
);

export const handler = async (
    event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
    const logger = baseLogger.child({
        requestId: event.requestContext.requestId,
        handler: 'media.confirm',
    });

    try {
        const principal = await extractPrincipal(event, authProvider);

        const user = await userService.getByCognitoSub(principal.sub);
        if (!user) {
            return notFound(
                'User profile not found. Call POST /v1/auth/sync first.',
            );
        }

        let input: ConfirmUploadInput;
        try {
            input = parseConfirmBody(event.body);
        } catch (err) {
            if (err instanceof ValidationFailure) {
                return validationError(err.message, err.details);
            }
            throw err;
        }

        try {
            const asset = await mediaService.confirmUpload(user.id, input);
            return ok(toMediaView(asset));
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
            if (err instanceof MediaStorageKeyMismatchError) {
                return validationError(err.message, { field: 'storageKey' });
            }
            if (err instanceof MediaOwnerNotFoundError) {
                return notFound(err.message);
            }
            if (err instanceof MediaNotOwnedError) {
                return forbidden(err.message);
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
        logger.error('media.confirm.failed', {
            error: err instanceof Error ? err.message : String(err),
        });
        return internalError();
    }
};

function parseConfirmBody(rawBody: string | null): ConfirmUploadInput {
    const obj = parseJsonObjectBody(rawBody, { allowEmpty: false });
    const result: ConfirmUploadInput = {
        ownerType: parseOwnerType(obj.ownerType),
        ownerId: parseRequiredUuid(obj.ownerId, 'ownerId'),
        storageKey: parseStorageKey(obj.storageKey),
        contentType: parseRequiredString(obj.contentType, 'contentType', 200),
    };
    const width = parseOptionalNonNegInt(obj.width, 'width');
    const height = parseOptionalNonNegInt(obj.height, 'height');
    return {
        ...result,
        ...(width !== undefined && { width }),
        ...(height !== undefined && { height }),
    };
}
