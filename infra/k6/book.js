// EthioLink — booking-creation load test.
//
// Targets 20 RPS sustained against POST /v1/appointments. Asserts
// error rate < 1 % and p95 latency < 1500 ms (a more generous
// budget than browse because the booking flow does a slot
// validation + payment authorization + a transactional INSERT).
//
// Required env:
//   * INVOKE_URL  — API Gateway base URL.
//   * AUTH_TOKEN  — Cognito ID token for a CUSTOMER user.
//   * BUSINESS_ID — UUID of an APPROVED business.
//   * SERVICE_ID  — UUID of an active service on that business.
//   * STAFF_ID    — UUID of an active staff member.
//   * STARTS_AT   — UTC ISO-8601 instant the booking targets.
//
// Caveat: every booking after the first against the same
// (STAFF_ID, STARTS_AT) returns 409 SLOT_UNAVAILABLE. The script
// counts those as a failure for thresholding purposes — to
// exercise the create path without the 409 noise, restart with a
// fresh STARTS_AT each run.
//
// See `infra/k6/README.md` for the full operator playbook.

import http from 'k6/http';
import { check, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REQUIRED_ENV = [
    'INVOKE_URL',
    'AUTH_TOKEN',
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
const AUTH_TOKEN = __ENV.AUTH_TOKEN;
const BUSINESS_ID = __ENV.BUSINESS_ID;
const SERVICE_ID = __ENV.SERVICE_ID;
const STAFF_ID = __ENV.STAFF_ID;
const STARTS_AT = __ENV.STARTS_AT;

// ---------------------------------------------------------------------------
// Custom metrics
// ---------------------------------------------------------------------------

const bookLatency = new Trend('ethiolink_book_latency', true);
const bookErrors = new Rate('ethiolink_book_errors');

// ---------------------------------------------------------------------------
// Stages + thresholds
// ---------------------------------------------------------------------------

export const options = {
    scenarios: {
        book: {
            executor: 'constant-arrival-rate',
            rate: 20,
            timeUnit: '1s',
            duration: '9m',
            preAllocatedVUs: 20,
            maxVUs: 100,
        },
    },
    thresholds: {
        ethiolink_book_latency: ['p(95) < 1500'],
        ethiolink_book_errors: ['rate < 0.01'],
        // Backstop: anything > 5 % HTTP failure rate fails fast.
        http_req_failed: ['rate < 0.05'],
    },
};

// ---------------------------------------------------------------------------
// Scenario body
// ---------------------------------------------------------------------------

export default function () {
    group('POST /v1/appointments', () => {
        const body = JSON.stringify({
            staffId: STAFF_ID,
            serviceId: SERVICE_ID,
            startsAt: STARTS_AT,
            paymentMethod: 'CASH',
            notes: null,
        });

        const res = http.post(`${BASE_URL}/v1/appointments`, body, {
            headers: {
                Authorization: `Bearer ${AUTH_TOKEN}`,
                'Content-Type': 'application/json',
            },
            tags: { name: 'book', endpoint: 'appointments-create' },
        });

        // 200 OK is the happy path. 409 SLOT_UNAVAILABLE is the
        // expected outcome for every request after the first
        // against the same (STAFF_ID, STARTS_AT) — operators
        // running back-to-back load tests should rotate
        // STARTS_AT between runs.
        const ok = res.status === 200;

        check(res, {
            'POST /v1/appointments returned 200': () => ok,
            'response carries an `appointment` object': () => {
                if (!ok) return false;
                try {
                    const body = res.json();
                    return typeof body === 'object' && body !== null && 'id' in body;
                } catch {
                    return false;
                }
            },
        });

        bookLatency.add(res.timings.duration);
        bookErrors.add(!ok);
    });
}
