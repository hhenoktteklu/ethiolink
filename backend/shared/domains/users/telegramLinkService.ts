// EthioLink — Telegram linking service.
//
// Phase 9 Track 2 foundation. Owns the application-layer logic for
// the three linking operations:
//
//   * `startLink(userId)` — generates a fresh, single-use code,
//     invalidates any prior in-flight code for the same user, and
//     returns the code + Telegram deep link + expiry. The HTTP
//     handler (future commit) wraps this for `POST /v1/me/link-
//     telegram/start`.
//
//   * `redeemCode(code, chatId)` — exchanges a code for the bound
//     user. Writes `users.telegram_chat_id = chatId` and deletes
//     the code in one logical step (the SQL-side transaction lives
//     in a future commit when the Lambda handler arrives; the
//     service-level guarantee is delete-on-success). Throws typed
//     errors on unknown / expired codes so the future webhook
//     handler can surface user-friendly copy.
//
//   * `unlink(userId)` — clears `users.telegram_chat_id`. Returns
//     `true` if the user had a chat id, `false` otherwise (idempotent
//     — re-unlinking is not an error).
//
// Design notes:
//   * Code generation: 32 base32 characters from
//     `crypto.randomBytes(20)`. ~100 bits of entropy — collision is
//     vanishingly unlikely, and the format reads cleanly when the
//     bot replays it back to the user in a confirmation message.
//     The character set is RFC 4648 base32 minus padding so the
//     code is URL-safe in the `?start=<code>` deep-link query.
//   * Deep link shape: `https://t.me/<botUsername>?start=<code>`.
//     `botUsername` comes from `TelegramProviderConfig.botUsername`
//     so the service is testable without hard-coding an env value.
//   * Expiry: configurable on the service constructor (defaults to
//     10 minutes). Long enough for the user to alt-tab into
//     Telegram, short enough that abandoned codes don't pile up.
//     The expiry is computed against an injected `Clock` so tests
//     can drive it deterministically.
//   * No DB transaction at this layer. The service is pure
//     orchestration over the two repositories; the Lambda handler
//     that wraps it can decide whether to start a transaction
//     (the redemption path is the obvious candidate — `findByCode`
//     + `setTelegramChatId` + `deleteByCode` should land
//     atomically when the SQL implementation lives behind one
//     `withTransaction`).

import { randomBytes } from 'node:crypto';

import type { Logger } from '../../logging/logger.js';

import type {
    TelegramLinkCode,
    TelegramLinkCodeRepository,
} from './telegramLinkCodeRepository.js';
import type { User, UserRepository } from './userRepository.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Returned by `startLink`. Surface used by the future HTTP handler. */
export interface StartedTelegramLink {
    /** The opaque single-use code. Embedded in the deep link. */
    readonly code: string;
    /** `https://t.me/<botUsername>?start=<code>` ready to open. */
    readonly deepLink: string;
    /** ISO-8601 UTC timestamp the code stops being valid. */
    readonly expiresAt: string;
}

/** Returned by `redeemCode`. The bound user + the (now-set) chat id. */
export interface RedeemedTelegramLink {
    readonly user: User;
    readonly chatId: string;
}

/** Minimal slice of `TelegramProviderConfig` the service needs. */
export interface TelegramLinkServiceConfig {
    /** Bot username without the leading `@`. Used to build the deep link. */
    readonly botUsername: string;
    /** Code TTL in seconds. Defaults to 600 (10 minutes) when 0. */
    readonly linkCodeTtlSeconds: number;
}

export interface Clock {
    now(): Date;
}

export const SYSTEM_CLOCK: Clock = Object.freeze({
    now: () => new Date(),
});

/**
 * Customisation seam for tests. Production passes nothing and gets
 * the default `crypto.randomBytes`-backed generator.
 */
export type CodeGenerator = () => string;

export interface TelegramLinkServiceDeps {
    readonly userRepo: UserRepository;
    readonly linkCodeRepo: TelegramLinkCodeRepository;
    readonly config: TelegramLinkServiceConfig;
    readonly logger: Logger;
    readonly clock?: Clock;
    readonly codeGenerator?: CodeGenerator;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Base class for the typed link errors so HTTP handlers can
 * switch on `instanceof` once and map to the right status code +
 * error code without parsing messages.
 */
export class TelegramLinkError extends Error {
    public readonly code: string;
    constructor(code: string, message: string) {
        super(message);
        this.name = 'TelegramLinkError';
        this.code = code;
    }
}

/** Raised by `redeemCode` when the supplied code is not in the table. */
export class TelegramLinkCodeNotFoundError extends TelegramLinkError {
    constructor() {
        super(
            'TELEGRAM_LINK_CODE_NOT_FOUND',
            'Linking code is not valid. Please restart the linking flow from the app.',
        );
        this.name = 'TelegramLinkCodeNotFoundError';
    }
}

/** Raised by `redeemCode` when the supplied code has expired. */
export class TelegramLinkCodeExpiredError extends TelegramLinkError {
    constructor() {
        super(
            'TELEGRAM_LINK_CODE_EXPIRED',
            'Linking code has expired. Please restart the linking flow from the app.',
        );
        this.name = 'TelegramLinkCodeExpiredError';
    }
}

/** Raised by `startLink` / `redeemCode` when the referenced user
 *  is missing or non-existent. */
export class TelegramLinkUserNotFoundError extends TelegramLinkError {
    constructor() {
        super(
            'TELEGRAM_LINK_USER_NOT_FOUND',
            'User does not exist for this linking attempt.',
        );
        this.name = 'TelegramLinkUserNotFoundError';
    }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 600;

export class TelegramLinkService {
    private readonly userRepo: UserRepository;
    private readonly linkCodeRepo: TelegramLinkCodeRepository;
    private readonly config: TelegramLinkServiceConfig;
    private readonly logger: Logger;
    private readonly clock: Clock;
    private readonly codeGenerator: CodeGenerator;

    constructor(deps: TelegramLinkServiceDeps) {
        this.userRepo = deps.userRepo;
        this.linkCodeRepo = deps.linkCodeRepo;
        this.config = deps.config;
        this.logger = deps.logger.child({ component: 'telegramLinkService' });
        this.clock = deps.clock ?? SYSTEM_CLOCK;
        this.codeGenerator = deps.codeGenerator ?? defaultCodeGenerator;
    }

    /**
     * Generate a fresh single-use code for `userId`. Any previous
     * in-flight code for the same user is dropped — the operator
     * tapped "Start linking" again and we honor that as an
     * implicit invalidation of the prior attempt.
     */
    async startLink(userId: string): Promise<StartedTelegramLink> {
        const user = await this.userRepo.findById(userId);
        if (!user) {
            throw new TelegramLinkUserNotFoundError();
        }

        await this.linkCodeRepo.deleteForUser(userId);

        const code = this.codeGenerator();
        const ttlSec =
            this.config.linkCodeTtlSeconds > 0
                ? this.config.linkCodeTtlSeconds
                : DEFAULT_TTL_SECONDS;
        const now = this.clock.now();
        const expiresAt = new Date(now.getTime() + ttlSec * 1000);

        await this.linkCodeRepo.insert({ code, userId, expiresAt });

        this.logger.info('Issued Telegram linking code.', {
            userId,
            expiresAt: expiresAt.toISOString(),
        });

        return Object.freeze<StartedTelegramLink>({
            code,
            deepLink: `https://t.me/${this.config.botUsername}?start=${encodeURIComponent(code)}`,
            expiresAt: expiresAt.toISOString(),
        });
    }

    /**
     * Redeem a code by binding the supplied `chatId` to the user
     * the code points at. Deletes the code on success (single
     * use). Throws typed errors for unknown / expired codes;
     * unknown user (stale FK target) maps to
     * `TelegramLinkUserNotFoundError`.
     */
    async redeemCode(
        code: string,
        chatId: string,
    ): Promise<RedeemedTelegramLink> {
        const trimmed = chatId.trim();
        if (trimmed === '') {
            throw new TelegramLinkError(
                'TELEGRAM_LINK_CHAT_ID_INVALID',
                'Chat id must be a non-empty string.',
            );
        }

        const row = await this.linkCodeRepo.findByCode(code);
        if (!row) {
            throw new TelegramLinkCodeNotFoundError();
        }

        const now = this.clock.now();
        if (row.expiresAt.getTime() < now.getTime()) {
            // Best-effort cleanup — the sweep job will pick this
            // up too. Failing the cleanup is non-fatal; surface
            // the typed expiry error either way.
            await this.linkCodeRepo
                .deleteByCode(code)
                .catch(() => undefined);
            throw new TelegramLinkCodeExpiredError();
        }

        const user = await this.userRepo.findById(row.userId);
        if (!user) {
            throw new TelegramLinkUserNotFoundError();
        }

        const updated = await this.userRepo.setTelegramChatId(
            row.userId,
            trimmed,
        );
        await this.linkCodeRepo.deleteByCode(code);

        this.logger.info('Redeemed Telegram linking code.', {
            userId: row.userId,
        });

        return Object.freeze<RedeemedTelegramLink>({
            user: updated,
            chatId: trimmed,
        });
    }

    /**
     * Clear the user's `telegram_chat_id`. Returns `true` if the
     * row had a chat id before this call, `false` when it was
     * already null. Idempotent: re-unlinking is not an error.
     */
    async unlink(userId: string): Promise<boolean> {
        const user = await this.userRepo.findById(userId);
        if (!user) {
            throw new TelegramLinkUserNotFoundError();
        }
        if (user.telegramChatId === null) {
            return false;
        }
        await this.userRepo.setTelegramChatId(userId, null);
        // Also clear any in-flight linking codes — the user
        // is explicitly opting out of Telegram, an outstanding
        // code would just confuse them.
        await this.linkCodeRepo.deleteForUser(userId);
        this.logger.info('Unlinked Telegram chat id.', { userId });
        return true;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Default 32-char base32 code generator. RFC 4648 alphabet minus
 * padding; uniform sample over 32 symbols × 32 positions = ~160
 * bits, more than enough to make collision impossible at our
 * scale.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_CODE_LENGTH = 32;

function defaultCodeGenerator(): string {
    const bytes = randomBytes(DEFAULT_CODE_LENGTH);
    let out = '';
    for (let i = 0; i < DEFAULT_CODE_LENGTH; i++) {
        // Each byte mod 32 yields one alphabet index. Slight bias
        // (256 not divisible by 32 — actually 256 = 32 × 8 so no
        // bias). Cheap, deterministic surface for the test fake.
        out += BASE32_ALPHABET[bytes[i]! & 0x1f]!;
    }
    return out;
}

/** Exported for tests that want to assert format. */
export function isLikelyDefaultLinkCode(code: string): boolean {
    if (code.length !== DEFAULT_CODE_LENGTH) return false;
    for (const ch of code) {
        if (!BASE32_ALPHABET.includes(ch)) return false;
    }
    return true;
}
