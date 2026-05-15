// EthioLink — read-path load test.
//
// Targets 100 RPS sustained for ~8 minutes against the public
// browse endpoints. Asserts p95 < 800 ms (the Phase 8 SLO on
// browse) and error rate < 1 %.
//
// Required env:
//   * INVOKE_URL      — API Gateway base URL, no trailing slash.
//                       Example:
//                       `https://abc.execute-api.eu-west-1.amazonaws.com/dev`
//
// Optional env:
//   * BUSINESS_ID     — when set, ~30% of requests hit the
//                       per-business reads. When unset, only
//                       `/v1/categories` + `/v1/businesses` are
//                       exercised.
//
// Run:
//   k6 run \
//     -e INVOKE_URL="$INVOKE_URL" \
//     -e BUSINESS_ID="<uuid>" \
//     infra/k6/browse.js
//
// See `infra/k6/README.md` for the full operator playbook.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const INVOKE_URL = __ENV.INVOKE_URL;
if (!INVOKE_URL) {
    throw new Error(
        'INVOKE_URL is required (e.g. https://abc.execute-api.eu-west-1.amazonaws.com/dev).',
    );
}
const BASE_URL = INVOKE_URL.replace(/\/$/, '');
const BUSINESS_ID = __ENV.BUSINESS_ID || '';

// ---------------------------------------------------------------------------
// Custom metrics — separate from the k6 defaults so the
// threshold assertions only consider this script's requests.
// ---------------------------------------------------------------------------

const browseLatency = new Trend('ethiolink_browse_latency', true);
const browseErrors = new Rate('ethiolink_browse_errors');

// ---------------------------------------------------------------------------
// Stages + thresholds
// ---------------------------------------------------------------------------

export const options = {
    // 100 RPS sustained for ~8 minutes, with 1-minute ramps.
    // k6's `constant-arrival-rate` executor pegs the request rate
    // regardless of latency (in contrast to `vus` which holds the
    // concurrency constant).
    scenarios: {
        browse: {
            executor: 'constant-arrival-rate',
            rate: 100,
            timeUnit: '1s',
            duration: '8m',
            preAllocatedVUs: 50,
            maxVUs: 200,
            // Brief ramp via a small warm-up before the main scenario
            // would be cleaner, but the constant-arrival-rate executor
            // doesn't support stages directly. For MVP we live with
            // the spike — Lambda cold-starts dominate the first 30 s
            // anyway.
        },
    },
    thresholds: {
        // p95 < 800 ms — the Phase 8 SLO on browse.
        ethiolink_browse_latency: ['p(95) < 800'],
        // Error rate < 1 %.
        ethiolink_browse_errors: ['rate < 0.01'],
        // Backstop: anything past 5 % failure rate fails fast.
        http_req_failed: ['rate < 0.05'],
    },
};

// ---------------------------------------------------------------------------
// Scenario body
// ---------------------------------------------------------------------------

export default function () {
    // Weighted mix:
    //   50% GET /v1/businesses
    //   20% GET /v1/categories
    //   30% per-business reads (when BUSINESS_ID is set)
    //
    // When BUSINESS_ID is unset, the 30% slice falls back to
    // GET /v1/businesses so the total stays at 100%.
    const r = Math.random();

    if (r < 0.5) {
        getBusinesses();
    } else if (r < 0.7) {
        getCategories();
    } else {
        if (BUSINESS_ID) {
            const r2 = Math.random();
            if (r2 < 0.4) getBusinessById();
            else if (r2 < 0.7) getServicesForBusiness();
            else if (r2 < 0.9) getStaffForBusiness();
            else getReviewsForBusiness();
        } else {
            getBusinesses();
        }
    }
}

// ---------------------------------------------------------------------------
// Per-endpoint helpers
// ---------------------------------------------------------------------------

function getCategories() {
    group('GET /v1/categories', () => {
        const res = http.get(`${BASE_URL}/v1/categories`, {
            tags: { name: 'browse', endpoint: 'categories' },
        });
        record(res, 'GET /v1/categories returned 200 with items[]', (r) =>
            r.status === 200 && hasItems(r),
        );
    });
}

function getBusinesses() {
    group('GET /v1/businesses', () => {
        const res = http.get(`${BASE_URL}/v1/businesses`, {
            tags: { name: 'browse', endpoint: 'businesses-list' },
        });
        record(res, 'GET /v1/businesses returned 200 with items[]', (r) =>
            r.status === 200 && hasItems(r),
        );
    });
}

function getBusinessById() {
    group('GET /v1/businesses/{businessId}', () => {
        const res = http.get(`${BASE_URL}/v1/businesses/${BUSINESS_ID}`, {
            tags: { name: 'browse', endpoint: 'business-detail' },
        });
        record(res, 'GET /v1/businesses/{businessId} returned 200', (r) =>
            r.status === 200,
        );
    });
}

function getServicesForBusiness() {
    group('GET /v1/businesses/{businessId}/services', () => {
        const res = http.get(`${BASE_URL}/v1/businesses/${BUSINESS_ID}/services`, {
            tags: { name: 'browse', endpoint: 'services-list' },
        });
        record(res, 'GET .../services returned 200 with items[]', (r) =>
            r.status === 200 && hasItems(r),
        );
    });
}

function getStaffForBusiness() {
    group('GET /v1/businesses/{businessId}/staff', () => {
        const res = http.get(`${BASE_URL}/v1/businesses/${BUSINESS_ID}/staff`, {
            tags: { name: 'browse', endpoint: 'staff-list' },
        });
        record(res, 'GET .../staff returned 200 with items[]', (r) =>
            r.status === 200 && hasItems(r),
        );
    });
}

function getReviewsForBusiness() {
    group('GET /v1/businesses/{businessId}/reviews', () => {
        const res = http.get(`${BASE_URL}/v1/businesses/${BUSINESS_ID}/reviews`, {
            tags: { name: 'browse', endpoint: 'reviews-list' },
        });
        record(res, 'GET .../reviews returned 200 with items[]', (r) =>
            r.status === 200 && hasItems(r),
        );
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function record(res, label, pass) {
    const ok = pass(res);
    check(res, { [label]: () => ok });
    browseLatency.add(res.timings.duration);
    browseErrors.add(!ok);
}

function hasItems(res) {
    try {
        const body = res.json();
        return Array.isArray(body.items);
    } catch {
        return false;
    }
}
