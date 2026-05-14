// EthioLink — opaque cursor codec and limit helpers.
//
// Extracted in Phase 3 from `businessService.ts` so additional paginated
// endpoints (services, staff, availability, future appointments) can
// share a single encode/decode implementation. The cursor format is
// intentionally generic:
//
//     base64url(JSON.stringify(payload))
//
// where `payload` is whatever shape the domain needs. Each domain
// provides its own runtime type guard at decode time, so a cursor
// minted by one endpoint cannot be honored by another with a
// different shape.

export class InvalidCursorError extends Error {
    constructor() {
        super('Cursor is malformed.');
        this.name = 'InvalidCursorError';
    }
}

/** Encode any JSON-serializable payload as an opaque cursor string. */
export function encodeCursor<P>(payload: P): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor string into a typed payload. The caller
 * supplies a runtime validator (`isValid`) to assert the decoded
 * shape; if the cursor cannot be parsed OR the validator rejects it,
 * throws {@link InvalidCursorError}.
 */
export function decodeCursor<P>(
    encoded: string,
    isValid: (value: unknown) => value is P,
): P {
    let parsed: unknown;
    try {
        const json = Buffer.from(encoded, 'base64url').toString('utf8');
        parsed = JSON.parse(json);
    } catch {
        throw new InvalidCursorError();
    }
    if (!isValid(parsed)) {
        throw new InvalidCursorError();
    }
    return parsed;
}

/**
 * Clamp a caller-provided `limit` to `[1, opts.max]`, falling back to
 * `opts.default` when missing, non-finite, or non-positive.
 */
export function clampLimit(
    requested: number | undefined,
    opts: { default: number; max: number },
): number {
    if (requested === undefined || !Number.isFinite(requested)) return opts.default;
    const integer = Math.trunc(requested);
    if (integer <= 0) return opts.default;
    return Math.min(integer, opts.max);
}
