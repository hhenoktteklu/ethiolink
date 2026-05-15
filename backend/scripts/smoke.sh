#!/usr/bin/env bash
# EthioLink — post-deploy smoke test.
#
# Validates an AWS-deployed environment end-to-end. Designed to
# run inside `deploy-dev.yml` after Terraform apply + migration
# run, but also usable by a human operator from any laptop with
# AWS credentials.
#
# Three assertions:
#
#   1. `GET ${INVOKE_URL}/v1/categories` returns HTTP 200 with a
#      JSON body containing an `items` array. This is the
#      public-read smoke path — exercises API Gateway routing,
#      the categories Lambda, RDS connectivity, and the seed
#      data. A failure here means one of those layers is broken.
#
#   2. `POST ${INVOKE_URL}/v1/auth/sync` without an
#      `Authorization` header returns HTTP 401. Asserts the
#      Cognito authorizer is wired to the right route. A 200 or
#      403 would indicate auth is misconfigured.
#
#   3. `aws lambda invoke` against the scheduled-reminders
#      function returns a JSON envelope whose response body has
#      the `scanned` / `sent` / `skipped` / `failed` keys. This
#      validates the scheduled lambda starts up, connects to
#      RDS, and returns its summary shape — without waiting for
#      the EventBridge 15-min cron.
#
# Usage:
#
#     INVOKE_URL=https://abc.execute-api.eu-west-1.amazonaws.com/dev \
#     REMINDER_FUNCTION_NAME=ethiolink-dev-scheduled-send-reminders \
#         bash backend/scripts/smoke.sh
#
# Exits 0 on success, 1 on any assertion failure. The deploy
# workflow treats a non-zero exit as deploy failure.
#
# Requires `curl`, `jq`, and the `aws` CLI on PATH. All three
# are pre-installed on the `ubuntu-22.04` GitHub runner.

set -euo pipefail

# -----------------------------------------------------------------------------
# Inputs
# -----------------------------------------------------------------------------

: "${INVOKE_URL:?INVOKE_URL must be set, e.g. https://abc.execute-api.eu-west-1.amazonaws.com/dev}"
: "${REMINDER_FUNCTION_NAME:?REMINDER_FUNCTION_NAME must be set, e.g. ethiolink-dev-scheduled-send-reminders}"

# Strip any trailing slash for clean URL composition.
INVOKE_URL="${INVOKE_URL%/}"

echo "==> Smoke test against ${INVOKE_URL}"
echo "    Reminder function: ${REMINDER_FUNCTION_NAME}"

failures=0

# -----------------------------------------------------------------------------
# 1. GET /v1/categories returns 200 + items[].
# -----------------------------------------------------------------------------

echo ""
echo "==> [1/3] GET /v1/categories"

categories_body="$(mktemp)"
categories_status=$(
    curl -s -o "${categories_body}" -w '%{http_code}' \
        "${INVOKE_URL}/v1/categories"
)

if [[ "${categories_status}" != "200" ]]; then
    echo "    FAIL: expected 200, got ${categories_status}"
    echo "    body:"
    sed 's/^/      /' "${categories_body}"
    failures=$((failures + 1))
else
    items_count=$(jq -r '.items | length' "${categories_body}" 2>/dev/null || echo "n/a")
    if [[ "${items_count}" == "n/a" || "${items_count}" == "null" ]]; then
        echo "    FAIL: response has no \`items\` array"
        echo "    body:"
        sed 's/^/      /' "${categories_body}"
        failures=$((failures + 1))
    else
        echo "    PASS: 200, items.length = ${items_count}"
    fi
fi

rm -f "${categories_body}"

# -----------------------------------------------------------------------------
# 2. POST /v1/auth/sync without Authorization returns 401.
# -----------------------------------------------------------------------------

echo ""
echo "==> [2/3] POST /v1/auth/sync (no JWT)"

auth_body="$(mktemp)"
auth_status=$(
    curl -s -o "${auth_body}" -w '%{http_code}' \
        -X POST -H 'Content-Type: application/json' \
        -d '{}' \
        "${INVOKE_URL}/v1/auth/sync"
)

if [[ "${auth_status}" != "401" ]]; then
    echo "    FAIL: expected 401, got ${auth_status}"
    echo "    body:"
    sed 's/^/      /' "${auth_body}"
    failures=$((failures + 1))
else
    echo "    PASS: 401 (Cognito authorizer rejected unauthenticated POST)"
fi

rm -f "${auth_body}"

# -----------------------------------------------------------------------------
# 3. aws lambda invoke scheduled-send-reminders returns the
#    expected summary shape.
# -----------------------------------------------------------------------------

echo ""
echo "==> [3/3] aws lambda invoke ${REMINDER_FUNCTION_NAME}"

reminder_response="$(mktemp)"
invoke_output="$(
    aws lambda invoke \
        --function-name "${REMINDER_FUNCTION_NAME}" \
        --cli-binary-format raw-in-base64-out \
        --payload '{}' \
        "${reminder_response}" 2>&1 || true
)"

# `aws lambda invoke` exits 0 even on Lambda runtime errors; the
# error is reflected in the response body's `FunctionError`
# field. We check both the CLI exit code (via the `|| true`
# above + the AWS_CLI status) and the response shape.

# First, verify the CLI command itself succeeded.
if ! echo "${invoke_output}" | jq -e '.StatusCode == 200' >/dev/null 2>&1; then
    echo "    FAIL: aws lambda invoke did not return StatusCode 200"
    echo "    aws output: ${invoke_output}"
    failures=$((failures + 1))
elif echo "${invoke_output}" | jq -e '.FunctionError' >/dev/null 2>&1; then
    echo "    FAIL: Lambda reported a FunctionError"
    echo "    aws output: ${invoke_output}"
    echo "    response:"
    sed 's/^/      /' "${reminder_response}"
    failures=$((failures + 1))
else
    # The response body is JSON written to ${reminder_response}.
    # Assert all four keys are present.
    missing="$(jq -r '
        [
            (if has("scanned") then null else "scanned" end),
            (if has("sent")    then null else "sent"    end),
            (if has("skipped") then null else "skipped" end),
            (if has("failed")  then null else "failed"  end)
        ]
        | map(select(. != null))
        | join(", ")
    ' "${reminder_response}" 2>/dev/null || echo 'all (parse error)')"

    if [[ -n "${missing}" ]]; then
        echo "    FAIL: response missing keys: ${missing}"
        echo "    response:"
        sed 's/^/      /' "${reminder_response}"
        failures=$((failures + 1))
    else
        scanned=$(jq -r '.scanned' "${reminder_response}")
        sent=$(jq -r '.sent' "${reminder_response}")
        skipped=$(jq -r '.skipped' "${reminder_response}")
        failed=$(jq -r '.failed' "${reminder_response}")
        echo "    PASS: { scanned=${scanned}, sent=${sent}, skipped=${skipped}, failed=${failed} }"
    fi
fi

rm -f "${reminder_response}"

# -----------------------------------------------------------------------------
# Report.
# -----------------------------------------------------------------------------

echo ""
if [[ "${failures}" -eq 0 ]]; then
    echo "==> All smoke checks passed."
    exit 0
else
    echo "==> ${failures} smoke check(s) failed."
    exit 1
fi
