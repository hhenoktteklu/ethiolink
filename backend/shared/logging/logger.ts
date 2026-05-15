// EthioLink — structured logger.
//
// Single-line JSON output, suited to CloudWatch Logs Insights. Every log entry
// carries `timestamp`, `level`, `message`, plus the bound context of the
// logger and any per-call metadata.
//
// Sensitive keys are redacted before serialization (see `SENSITIVE_KEYS`).
// Per the Phase 1 test plan, we must never log the JWT itself.
//
// Design notes:
//   * Lambda-friendly: writes directly to `stdout` / `stderr`. No transport
//     plugins, no async flushing. CloudWatch Logs picks up stdout/stderr
//     automatically.
//   * No external dependencies. Pino / Winston would do this better at scale
//     but the project hard-rule is "no new deps without justification".
//   * `child()` returns a new Logger whose bound context is merged with the
//     parent's. Useful for stamping every line in a request with the request
//     id and Cognito sub.

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
    debug(message: string, meta?: Record<string, unknown>): void;
    info(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
    error(message: string, meta?: Record<string, unknown>): void;

    /** Return a new logger that inherits this one's level and merges `context`. */
    child(context: Record<string, unknown>): Logger;

    /** The current minimum level. Exposed for tests and conditional formatting. */
    readonly level: LogLevel;
}

interface LoggerOptions {
    /** Minimum level that will actually be emitted. */
    readonly level: LogLevel;
    /** Bound context merged into every log line. */
    readonly context?: Record<string, unknown>;
    /**
     * Dynamic context resolved at emit time. The Phase 8
     * observability shim wires
     * `getCurrentRequestContextRecord` from
     * `shared/observability/correlationId.ts` here so every log
     * line auto-stamps `requestId` / `cognitoSub` / `route` /
     * `method` / `handler` without the caller threading them
     * through `child(...)`. Defaults to `undefined` — backward
     * compatible.
     *
     * Merge order: dynamic context < bound context < per-call
     * `meta`. Concrete log calls win.
     */
    readonly contextProvider?: () => Record<string, unknown>;
    /** Test seam: where to write output. Defaults to console. */
    readonly sink?: LogSink;
    /** Test seam: clock for the `timestamp` field. */
    readonly now?: () => Date;
}

export interface LogSink {
    write(level: LogLevel, line: string): void;
}

const LEVEL_ORDER: Readonly<Record<LogLevel, number>> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

/**
 * Keys whose values are redacted in any logged metadata. Matching is
 * case-insensitive and recursive (nested objects are scrubbed too).
 *
 * If you add a new sensitive field anywhere in the codebase, add its key
 * here too.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set(
    [
        'password',
        'token',
        'jwt',
        'authorization',
        'accesstoken',
        'idtoken',
        'refreshtoken',
        'cookie',
        'set-cookie',
        'secret',
        'apikey',
        'api_key',
        'client_secret',
    ].map((k) => k.toLowerCase()),
);

const REDACTED = '[REDACTED]';

const CONSOLE_SINK: LogSink = {
    write(level, line) {
        if (level === 'error' || level === 'warn') {
            // eslint-disable-next-line no-console -- CloudWatch consumes stderr.
            console.error(line);
        } else {
            // eslint-disable-next-line no-console -- CloudWatch consumes stdout.
            console.log(line);
        }
    },
};

/**
 * Create a new logger. Tests can inject a `sink` and `now` clock; production
 * code passes only the level.
 */
export function createLogger(options: LoggerOptions): Logger {
    const level = options.level;
    const context = options.context ?? {};
    const contextProvider = options.contextProvider;
    const sink = options.sink ?? CONSOLE_SINK;
    const now = options.now ?? (() => new Date());

    const emit = (entryLevel: LogLevel, message: string, meta?: Record<string, unknown>): void => {
        if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) {
            return;
        }
        // Resolve the dynamic context (if any) at emit time so
        // each log line picks up the *current* ALS scope — the
        // logger instance is constructed at cold-start, but the
        // request context changes per invocation.
        const dynamicContext = contextProvider ? contextProvider() : {};
        const payload: Record<string, unknown> = {
            timestamp: now().toISOString(),
            level: entryLevel,
            message,
            ...redact(dynamicContext),
            ...redact(context),
            ...(meta ? redact(meta) : {}),
        };
        sink.write(entryLevel, JSON.stringify(payload));
    };

    return Object.freeze<Logger>({
        level,
        debug: (m, meta) => emit('debug', m, meta),
        info: (m, meta) => emit('info', m, meta),
        warn: (m, meta) => emit('warn', m, meta),
        error: (m, meta) => emit('error', m, meta),
        child: (childContext) =>
            createLogger({
                level,
                context: { ...context, ...childContext },
                contextProvider,
                sink,
                now,
            }),
    });
}

/**
 * Return a deep copy of `input` with any sensitive keys' values replaced by
 * "[REDACTED]". Arrays and primitives are passed through. Circular references
 * are not expected in log payloads; if they occur, JSON.stringify will catch
 * them downstream.
 */
function redact(input: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        out[key] = SENSITIVE_KEYS.has(key.toLowerCase())
            ? REDACTED
            : redactValue(value);
    }
    return out;
}

function redactValue(value: unknown): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (Array.isArray(value)) {
        return value.map(redactValue);
    }
    return redact(value as Record<string, unknown>);
}
