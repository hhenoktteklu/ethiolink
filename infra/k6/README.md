# EthioLink — k6 Load Tests

Three Grafana k6 scripts that exercise the deployed EthioLink API against the Phase 8 acceptance criteria:

- **100 RPS on read paths for 10 minutes** with **p95 < 800 ms** on browse (`GET /v1/businesses`).
- **20 RPS on booking creation for 10 minutes** with **error rate < 1%**.

The scripts are deliberately runnable from any laptop — no Lambda-side instrumentation, no Terraform changes, no destructive side effects beyond the rows the booking flow creates. Run them against `dev` until prod is stable enough to absorb the traffic.

## Install k6

The scripts target k6 `0.49+` (released 2024-02). Install via the official channels:

```bash
# macOS
brew install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

`k6 version` should print `≥ v0.49.0`.

## Common environment variables

Every script reads `INVOKE_URL` — the API Gateway base URL (no trailing slash). The deploy workflow exposes this via `terraform output -raw api_gateway_invoke_url`. Example:

```bash
export INVOKE_URL="https://abc123.execute-api.eu-west-1.amazonaws.com/dev"
```

Script-specific env vars are documented inline in each script's header comment and summarised below.

## Scripts

### `browse.js` — read-path mix at 100 RPS

```bash
k6 run \
  -e INVOKE_URL="$INVOKE_URL" \
  -e BUSINESS_ID="<approved-business-uuid>" \
  infra/k6/browse.js
```

Required env: `INVOKE_URL`.
Optional env: `BUSINESS_ID` (when set, ~30 % of requests hit `GET /v1/businesses/{businessId}` and the per-business `services` / `staff` / `reviews` reads). When unset, the script only exercises `GET /v1/categories` + `GET /v1/businesses`.

Stage profile (default — override with `--duration` / `--vus`):
- 1 min ramp from 0 → 100 RPS
- 8 min sustained at 100 RPS
- 1 min ramp down

Thresholds (built-in `--out summary` checks):
- `http_req_duration{name:browse}` p95 < `800` ms
- `http_req_failed{name:browse}` rate < `0.01` (1 %)

Exit code is non-zero on any threshold breach.

### `book.js` — booking creation at 20 RPS

```bash
k6 run \
  -e INVOKE_URL="$INVOKE_URL" \
  -e AUTH_TOKEN="$(cat /tmp/cognito-id-token.jwt)" \
  -e BUSINESS_ID="<approved-business-uuid>" \
  -e SERVICE_ID="<active-service-uuid>" \
  -e STAFF_ID="<active-staff-uuid>" \
  -e STARTS_AT="2026-06-01T08:00:00.000Z" \
  infra/k6/book.js
```

Required env:
- `INVOKE_URL`
- `AUTH_TOKEN` — a valid Cognito ID token for a CUSTOMER user. Stage one via the dev pool's hosted UI + paste it; production runs use a token-minting helper documented in `docs/operations/RUNBOOK.md` (Phase 8 follow-up).
- `BUSINESS_ID`, `SERVICE_ID`, `STAFF_ID` — IDs that resolve to an APPROVED business + an active service + an active staff member. The booking flow refuses anything else.
- `STARTS_AT` — UTC ISO-8601 timestamp the booking targets. The script does **not** pre-walk the slot list; it relies on the operator picking a bookable instant. Use `infra/k6/full-lifecycle.js` for the flow that does discover slots first.

Stage profile:
- 30 s ramp from 0 → 20 RPS
- 9 min sustained at 20 RPS
- 30 s ramp down

Thresholds:
- `http_req_failed{name:book}` rate < `0.01` (1 %)
- `http_req_duration{name:book}` p95 < `1500` ms

Because every booking is a real INSERT, the script accumulates `appointments` rows for the same `(staff_id, starts_at)` slot — every booking after the first against the same `STARTS_AT` returns 409 `SLOT_UNAVAILABLE`. That's expected. To exercise the create path without the 409 noise, restart the script with a fresh `STARTS_AT` each run, or wire a small slot-walker script first.

### `full-lifecycle.js` — end-to-end booking lifecycle

```bash
k6 run \
  -e INVOKE_URL="$INVOKE_URL" \
  -e CUSTOMER_TOKEN="$(cat /tmp/customer.jwt)" \
  -e OWNER_TOKEN="$(cat /tmp/owner.jwt)" \
  -e BUSINESS_ID="<approved-business-uuid>" \
  -e SERVICE_ID="<active-service-uuid>" \
  -e STAFF_ID="<active-staff-uuid>" \
  -e STARTS_AT="2026-06-01T08:00:00.000Z" \
  infra/k6/full-lifecycle.js
```

Required env: every variable from `book.js` plus `OWNER_TOKEN` (a Cognito ID token for the business owner who can `accept` and `complete` the appointment).

The script runs **once per iteration** at a low RPS (default 1 VU, ~1–2 iters/min). Each iteration:

1. `POST /v1/appointments` (customer)
2. `POST /v1/appointments/{id}/accept` (owner)
3. `POST /v1/appointments/{id}/complete` (owner — fast-forwards via Lambda env override; in prod the script just asserts the route returns 409 `INVALID_TRANSITION` because the appointment is in the future)
4. `POST /v1/appointments/{id}/review` (customer)

It's smoke flow not a load profile — designed to catch state-machine regressions, not to stress the system. Run it once after every prod deploy as a heartbeat.

Thresholds:
- `checks` rate > `0.99` (every step passes the inline assertions)
- `http_req_failed` rate < `0.05` (allows a few 4xx from the `complete` step in prod)

## Running against dev vs. prod

Default targets are dev. To run against prod, set `INVOKE_URL` to the prod output:

```bash
INVOKE_URL=$(cd infra/terraform/environments/prod && terraform output -raw api_gateway_invoke_url) \
    k6 run infra/k6/browse.js
```

**Caveats on prod runs:**
- WAF rate limits (default 2 000 req / 5 min / IP) reject runs from a single laptop IP at 100 RPS sustained. Either temporarily widen the rate limit via the env-level `waf_rate_limit_per_5min` variable for the duration of the test, OR run k6 from multiple cloud-distributed sources (the Grafana k6 Cloud integration is the cleanest path).
- The booking script creates real rows. Schedule prod runs for the maintenance window and clean up via `aws lambda invoke` of a future admin-purge handler (Phase 8.5).

## Interpreting the output

k6's default text summary at the end of a run shows:

```
     ✓ GET /v1/categories returns 200
     ✓ GET /v1/businesses returns 200 with items[]

     checks.........................: 100.00% ✓ 60000      ✗ 0
     http_req_duration..............: avg=185ms p(95)=420ms p(99)=620ms
     http_req_duration{name:browse}: avg=180ms p(95)=410ms p(99)=600ms   ← assert < 800ms
     http_req_failed................: 0.00%   ✓ 0          ✗ 60000
     http_reqs......................: 60000   100.00/s                  ← assert ~100/s
     iteration_duration.............: avg=1.01s
     vus............................: 100     min=100 max=100
```

The **threshold lines** (suffixed with `← assert`) are what the script enforces. Any line that ends with `… ✗` means the script's exit code is non-zero and the load test failed.

Common failure shapes:
- **p95 spikes early then settles** — Lambda cold-starts. Acceptable for the first 30 s; the threshold is on the full-run aggregate.
- **`http_req_failed` > 1 % with HTTP 502** — Lambda errors (check the per-function dashboard).
- **`http_req_failed` > 1 % with HTTP 429 or 403** — WAF rate limit; widen the threshold or run from multiple IPs.
- **`http_req_failed` > 1 % with HTTP 409 from `book.js`** — every booking after the first targets the same `(staff, starts_at)` — restart with a fresh `STARTS_AT`.

## Phase 8 acceptance gates

The Phase 8 doc requires the following load-test results before declaring the phase complete:

| Test                                  | RPS | Duration | p95 budget        | Error budget |
| ------------------------------------- | --- | -------- | ----------------- | ------------ |
| `browse.js` against dev               | 100 | 10 min   | < 800 ms          | < 1 %        |
| `book.js` against dev                 | 20  | 10 min   | < 1500 ms         | < 1 %        |
| `full-lifecycle.js` against dev       | 1   | 5 iters  | n/a (smoke)       | < 5 % (allow 409 on `complete`) |

Captured numbers go into `docs/operations/SLOs.md` (Phase 8 follow-up) as the established baseline. The tuning commit that follows uses these numbers to right-size the Lambda memory / RDS connection alarm threshold / WAF rate limit per the documented playbook.
