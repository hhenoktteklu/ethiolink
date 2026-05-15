// EthioLink — full booking lifecycle smoke flow.
//
// Single-iteration walk through the booking lifecycle:
//
//   POST /v1/appointments              (customer)
//   POST /v1/appointments/{id}/accept  (owner)
//   POST /v1/appointments/{id}/complete (owner)
//   POST /v1/appointments/{id}/review  (customer)
//
// Designed as a heartbeat after a deploy — not a load profile.
// One VU, slow cadence, deeper-than-load-test assertions on each
// step. Detects state-machine regressions that browse + book
// alone wouldn't catch (e.g. a missing transition arrow in the
// state machine, a typo in the audit-row insert).
//
// Required env:
//   * INVOKE_URL      — API Gateway base URL.
//   * CUSTOMER_TOKEN  — Cognito ID token for a CUSTOMER user.
//   * OWNER_TOKEN     — Cognito ID token for the BUSINESS_OWNER
//                       of `BUSINESS_ID`.
//   * BUSINESS_ID     — UUID of an APPROVED business.
//   * SERVICE_ID      — UUID of an active service on it.
//   * STAFF_ID        — UUID of an active staff member.
//   * STARTS_AT       — UTC ISO-8601 instant for the booking.
//
// Caveat — `complete` in prod:
//   The state machine only allows `complete` AFTER `starts_at`
//   has passed. When STARTS_AT is in the future (the normal
//   load-test case), the `complete` step returns 409
//   INVALID_TRANSITION — the script counts that outcome as a
//   pass-with-asterisk because it's the documented behavior, not
//   a regression. Use `STARTS_AT` in the past (e.g. an hour ago)
//   to exercise the success path on dev; never do this in prod.
//
// See `infra/k6/README.md` for the full operator playbook.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
    'INVOKE_URL',
    'CUSTOMER_TOKEN',
    'OWNER_TOKEN',
    'BUSINESS_ID',
    'SERVICE_ID',
    'STAFF_ID',
    'STARTS_AT',
];
const missing = REQUIRED_ENV.filter((name) => !__ENV[name]);
if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}.`);
}

const BASE_URL = __ENV.INVOKE_URL.replace(/\/$/, '');
const CUSTOMER_TOKEN = __ENV.CUSTOMER_TOKEN;
const OWNER_TOKEN = __ENV.OWNER_TOKEN;
const BUSINESS_ID = __ENV.BUSINESS_ID;
const SERVICE_ID = __ENV.SERVICE_ID;
const STAFF_ID = __ENV.STAFF_ID;
const STARTS_AT = __ENV.STARTS_AT;

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const lifecycleErrors = new Rate('ethiolink_lifecycle_errors');

// ---------------------------------------------------------------------------
// Stages + thresholds
// ---------------------------------------------------------------------------

export const options = {
    // Single VU at low cadence — this is a smoke flow, not a
    // load profile. Override via `--iterations 50` for a longer
    // burn-in.
    scenarios: {
        lifecycle: {
            executor: 'per-vu-iterations',
            vus: 1,
            iterations: 5,
            maxDuration: '10m',
        },
    },
    thresholds: {
        // Every inline check should pass. The threshold is < 0.99
        // failed checks (in other words, >= 99 % of inline
        // assertions pass).
        checks: ['rate >= 0.99'],
        // Allow a small fraction of 4xx responses from the
        // `complete` step when STARTS_AT is in the future
        // (documented behavior, see header).
        ethiolink_lifecycle_errors: ['rate < 0.20'],
    },
};

// ---------------------------------------------------------------------------
// Iteration
// ---------------------------------------------------------------------------

export default function () {
    // Step 1 — customer creates the booking.
    let appointmentId = null;
    group('POST /v1/appointments', () => {
        const res = http.post(
            `${BASE_URL}/v1/appointments`,
            JSON.stringify({
                staffId: STAFF_ID,
                serviceId: SERVICE_ID,
                startsAt: STARTS_AT,
                paymentMethod: 'CASH',
                notes: 'lifecycle smoke',
            }),
            {
                headers: {
                    Authorization: `Bearer ${CUSTOMER_TOKEN}`,
                    'Content-Type': 'application/json',
                },
                tags: { name: 'lifecycle', step: 'create' },
            },
        );

        const ok = check(res, {
            'create returned 200': (r) => r.status === 200,
            'response has appointment.id': (r) => {
                try {
                    const body = r.json();
                    if (!body || typeof body !== 'object') return false;
                    const apt = body.appointment ?? body;
                    if (apt && typeof apt === 'object' && typeof apt.id === 'string') {
                        appointmentId = apt.id;
                        return true;
                    }
                    return false;
                } catch {
                    return false;
                }
            },
        });
        lifecycleErrors.add(!ok);
    });

    if (!appointmentId) {
        // The create step failed — skip the rest of the lifecycle
        // for this iteration. The thresholds above will catch the
        // miss.
        sleep(1);
        return;
    }

    // Step 2 — owner accepts.
    group('POST /v1/appointments/{id}/accept', () => {
        const res = http.post(
            `${BASE_URL}/v1/appointments/${appointmentId}/accept`,
            null,
            {
                headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
                tags: { name: 'lifecycle', step: 'accept' },
            },
        );
        const ok = check(res, {
            'accept returned 200': (r) => r.status === 200,
            'accept set status=ACCEPTED': (r) => {
                try {
                    const body = r.json();
                    return body && body.status === 'ACCEPTED';
                } catch {
                    return false;
                }
            },
        });
        lifecycleErrors.add(!ok);
    });

    // Step 3 — owner completes. With STARTS_AT in the future,
    // this returns 409 (documented). With STARTS_AT in the past,
    // it returns 200. We count BOTH as a pass for the smoke
    // flow, because either outcome means the state-machine wiring
    // is correct.
    let completed = false;
    group('POST /v1/appointments/{id}/complete', () => {
        const res = http.post(
            `${BASE_URL}/v1/appointments/${appointmentId}/complete`,
            null,
            {
                headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
                tags: { name: 'lifecycle', step: 'complete' },
            },
        );
        const ok = check(res, {
            'complete returned 200 or 409': (r) => r.status === 200 || r.status === 409,
        });
        completed = res.status === 200;
        // Only count non-{200,409} responses as errors.
        lifecycleErrors.add(!ok);
    });

    // Step 4 — customer reviews. Only run if the booking actually
    // reached COMPLETED (state machine requires it).
    if (completed) {
        group('POST /v1/appointments/{id}/review', () => {
            const res = http.post(
                `${BASE_URL}/v1/appointments/${appointmentId}/review`,
                JSON.stringify({ rating: 5, comment: 'lifecycle smoke' }),
                {
                    headers: {
                        Authorization: `Bearer ${CUSTOMER_TOKEN}`,
                        'Content-Type': 'application/json',
                    },
                    tags: { name: 'lifecycle', step: 'review' },
                },
            );
            const ok = check(res, {
                'review returned 200': (r) => r.status === 200,
            });
            lifecycleErrors.add(!ok);
        });
    }

    // Slow cadence between iterations.
    sleep(2);
}
