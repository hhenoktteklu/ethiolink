// EthioLink — X-Ray tracing helpers.
//
// Phase 8 observability primitive: enable AWS X-Ray on the
// Lambda runtime + provide a hook that future commits can use to
// capture AWS SDK + Postgres driver calls inside the trace.
//
// What this module DOES today:
//
//   * Detect whether the Lambda execution environment has X-Ray
//     tracing enabled via the standard `AWS_XRAY_DAEMON_ADDRESS`
//     env var (AWS sets it automatically when the function's
//     `tracing_config.mode = "Active"` — see the Terraform
//     Lambda module).
//
//   * Provide a `captureAwsClient(client)` no-op stub that future
//     commits will replace with an `aws-xray-sdk-core`-backed
//     wrapper.
//
// What this module deliberately does NOT do yet:
//
//   * Import `aws-xray-sdk-core`. The package is ~MB; adding it
//     to `backend/package.json` is held off until a real call
//     site needs SDK-call instrumentation. Lambda-level traces
//     (cold-start, function duration, billing-relevant metrics)
//     light up immediately via the `tracing_config = "Active"`
//     change in the Terraform Lambda module; per-SDK-call
//     sub-segments require the SDK package and are the natural
//     follow-up.
//
//   * Patch `pg.Pool`. Postgres driver traces aren't built into
//     `aws-xray-sdk-core`; the `aws-xray-sdk-postgres` companion
//     package wraps it. Also deferred until the follow-up.
//
// The shape is the same as `loadSecretsThenConfig`'s lazy-import
// pattern: keep the call sites stable, let the implementation
// fill in later without a breaking change.

/**
 * Detect whether X-Ray tracing is active for this Lambda
 * invocation. AWS sets `AWS_XRAY_DAEMON_ADDRESS` on every
 * function whose `tracing_config.mode = "Active"`; the absence
 * is the unambiguous "tracing off" signal.
 *
 * Application code should not need to check this directly — the
 * `captureAwsClient` wrapper below is a no-op when tracing is
 * off, so the cold-start cost is one env-var read per Lambda.
 */
export function isXRayEnabled(): boolean {
    return typeof process.env.AWS_XRAY_DAEMON_ADDRESS === 'string'
        && process.env.AWS_XRAY_DAEMON_ADDRESS.trim() !== '';
}

/**
 * Wrap an AWS SDK v3 client with X-Ray instrumentation so each
 * SDK call appears as a sub-segment under the Lambda's main
 * trace. Today this is a no-op pass-through; the next Phase 8
 * commit replaces the body with a lazy-import of
 * `aws-xray-sdk-core` and a call to its `captureAWSv3Client`.
 *
 * Call sites should adopt this wrapper at construction time
 * even though it's a no-op today — that way the SDK-instrumentation
 * commit is a single-file change with no handler refactor.
 *
 * @template T   SDK client type (e.g. `S3Client`, `SecretsManagerClient`).
 * @param client The constructed SDK client.
 * @returns      Either the X-Ray-wrapped client or the original
 *               client, depending on whether tracing is active.
 */
export function captureAwsClient<T>(client: T): T {
    if (!isXRayEnabled()) {
        return client;
    }
    // TODO: lazy-import `aws-xray-sdk-core` and call
    // `captureAWSv3Client(client)`. Deferred until a real call
    // site needs SDK-call sub-segments; the env-var check above
    // means the no-op path is the steady state for handlers that
    // don't adopt the wrapper.
    return client;
}

/**
 * Annotate the active X-Ray segment with a key / value pair.
 * Annotations are indexed by X-Ray so the operator can filter
 * traces by appointment id, business id, etc. when investigating
 * a single failed request.
 *
 * No-op when tracing is off OR until the SDK lazy-import lands.
 * The function exists so the call sites can land first; the
 * implementation follows.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- params required by interface.
export function annotateTrace(_key: string, _value: string | number | boolean): void {
    // Deferred. See `captureAwsClient` note.
}
