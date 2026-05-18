#!/usr/bin/env bash
# EthioLink — dev Cognito user seeder.
#
# WARNING — DEV ONLY.
#   Creates three predictable accounts in a Cognito user pool, sets
#   permanent passwords, marks emails verified, and adds each one to
#   the appropriate Cognito group. The credentials are HARD-CODED so
#   they show up in commit history; never run this against the
#   production user pool.
#
# Created accounts (see also docs/operations/runbooks/dev-cognito-users.md):
#
#     customer@ethiolink.test   → CUSTOMER group        (mobile customer)
#     owner@ethiolink.test      → BUSINESS_OWNER group  (mobile business)
#     admin@ethiolink.test      → ADMIN group           (admin SPA)
#
# Default shared password: EthioLinkDev@2026 — meets the user pool's
# password policy (≥12 chars, mixed case, digit, symbol). Override
# with `--password` if your dev pool tightens the policy.
#
# Usage:
#     bash backend/scripts/seed-dev-cognito-users.sh \
#         --region eu-west-1 \
#         --user-pool-id eu-west-1_xxxxxxxxx \
#         [--password EthioLinkDev@2026]
#
# Discovery shortcut (operators who set up the dev env via this repo):
#     POOL_ID=$(terraform -chdir=infra/terraform/environments/dev \
#                 output -raw cognito_user_pool_id)
#     bash backend/scripts/seed-dev-cognito-users.sh \
#         --region eu-west-1 --user-pool-id "$POOL_ID"
#
# Idempotency contract:
#   * `admin-create-user` returns `UsernameExistsException` for
#     existing emails — caught + treated as success.
#   * `admin-set-user-password --permanent` overwrites whatever
#     password is on file, so re-running rotates the password back
#     to the one the script knows. Also clears the FORCE_CHANGE_
#     PASSWORD challenge state.
#   * `admin-update-user-attributes` is idempotent.
#   * `admin-add-user-to-group` returns success even when the user
#     is already in the group — no exception handling needed.
#
# After the seeder finishes successfully, the operator drives one
# real sign-in per account (mobile hosted UI for the two mobile
# roles, admin SPA for ADMIN). The mobile app's
# `LoginScreen → AuthSyncRepository.sync()` pipeline (see the
# previous commit "Sync backend user profile after mobile sign-in")
# creates the `users` row on first login; the role column is set
# by `UserService.syncFromPrincipal` from the ID-token's
# `cognito:groups` claim via the `deriveRole` precedence rule
# (ADMIN > BUSINESS_OWNER > CUSTOMER).
#
# Operator drives at LEAST one sign-in per seeded user so the
# downstream verification steps in
# `docs/operations/runbooks/dev-cognito-users.md` see the `users`
# rows populate.

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-eu-west-1}}"
USER_POOL_ID=""
PASSWORD="EthioLinkDev@2026"

usage() {
    cat <<'USAGE'
seed-dev-cognito-users.sh — idempotent dev-only Cognito seeder.

Required:
    --user-pool-id <id>     Cognito user pool ID (eu-west-1_xxxxxxxxx).
                            Resolve with:
                              terraform -chdir=infra/terraform/environments/dev \
                                output -raw cognito_user_pool_id

Optional:
    --region <region>       AWS region. Defaults to AWS_REGION env var
                            then AWS_DEFAULT_REGION then eu-west-1.
    --password <pw>         Shared dev password. Defaults to the
                            value documented in
                            docs/operations/runbooks/dev-cognito-users.md.
    -h, --help              Show this help.

Refuses to run if the user-pool ID matches the prod env's exported
name (`-prod-` in the name attribute). Override at your own risk by
exporting ETHIOLINK_ALLOW_PROD_COGNITO_SEED=1 — but really, don't.
USAGE
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --region)        REGION="$2"; shift 2 ;;
        --user-pool-id)  USER_POOL_ID="$2"; shift 2 ;;
        --password)      PASSWORD="$2"; shift 2 ;;
        -h|--help)       usage; exit 0 ;;
        *)               echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
    esac
done

if [[ -z "$USER_POOL_ID" ]]; then
    echo "Error: --user-pool-id is required." >&2
    usage >&2
    exit 2
fi

if ! command -v aws >/dev/null 2>&1; then
    echo "Error: aws CLI not found on PATH. Install it from " \
         "https://aws.amazon.com/cli/ before running this script." >&2
    exit 127
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "Error: jq not found on PATH. Install with your package " \
         "manager (apt/brew) before running this script." >&2
    exit 127
fi

# ---------------------------------------------------------------------------
# Production guardrail
# ---------------------------------------------------------------------------
#
# Anyone who supplies a `-prod-` user-pool ID has almost certainly
# typo'd or copy-pasted the wrong terraform output. Refuse loudly
# unless the operator explicitly opts in via env var. The pool's
# Name attribute (set by Terraform) is the source of truth.

POOL_NAME="$(
    aws cognito-idp describe-user-pool \
        --region "$REGION" \
        --user-pool-id "$USER_POOL_ID" \
        --query 'UserPool.Name' \
        --output text 2>/dev/null || true
)"

if [[ -z "$POOL_NAME" || "$POOL_NAME" == "None" ]]; then
    echo "Error: could not describe user pool $USER_POOL_ID in region " \
         "$REGION. Check the ID and your AWS credentials." >&2
    exit 1
fi

case "$POOL_NAME" in
    *-prod-*|*-prod|ethiolink-prod-*)
        if [[ "${ETHIOLINK_ALLOW_PROD_COGNITO_SEED:-0}" != "1" ]]; then
            cat >&2 <<EOM
Refusing to seed users into "$POOL_NAME". This script writes
hardcoded dev credentials and is for DEV USE ONLY. If you really
mean to do this in production, re-run with
ETHIOLINK_ALLOW_PROD_COGNITO_SEED=1 set in your environment.
EOM
            exit 1
        fi
        ;;
esac

echo "==> Seeding dev Cognito users"
echo "    Pool ID  : $USER_POOL_ID"
echo "    Pool name: $POOL_NAME"
echo "    Region   : $REGION"
echo

# ---------------------------------------------------------------------------
# Seed table
# ---------------------------------------------------------------------------
#
# Email is the username (the pool's Username Attribute is `email`,
# per the Terraform module's `username_attributes = ["email"]`). The
# Cognito-side username is the email's lowercase form.

SEEDS=(
    'customer@ethiolink.test;Customer Demo;CUSTOMER'
    'owner@ethiolink.test;Owner Demo;BUSINESS_OWNER'
    'admin@ethiolink.test;Admin Demo;ADMIN'
)

# ---------------------------------------------------------------------------
# Per-account upsert
# ---------------------------------------------------------------------------

upsert_user() {
    local email="$1"
    local display_name="$2"
    local group="$3"

    echo "==> $email -> group $group"

    # 1. admin-create-user. Suppress the welcome email; we don't
    #    want Cognito mailing the ethiolink.test address.
    set +e
    create_out="$(
        aws cognito-idp admin-create-user \
            --region "$REGION" \
            --user-pool-id "$USER_POOL_ID" \
            --username "$email" \
            --user-attributes \
                Name=email,Value="$email" \
                Name=email_verified,Value=true \
                Name=name,Value="$display_name" \
            --message-action SUPPRESS 2>&1
    )"
    create_rc=$?
    set -e

    if [[ $create_rc -ne 0 ]]; then
        if echo "$create_out" | grep -q 'UsernameExistsException'; then
            echo "    user exists — continuing with attribute + password + group sync"
        else
            echo "$create_out" >&2
            return 1
        fi
    else
        echo "    created."
    fi

    # 2. Force email_verified=true + display name on existing users
    #    too. (admin-create-user only seeds attributes on NEW users.)
    aws cognito-idp admin-update-user-attributes \
        --region "$REGION" \
        --user-pool-id "$USER_POOL_ID" \
        --username "$email" \
        --user-attributes \
            Name=email_verified,Value=true \
            Name=name,Value="$display_name" \
        >/dev/null
    echo "    email_verified=true, name=\"$display_name\""

    # 3. Permanent password. --permanent flips the user from
    #    FORCE_CHANGE_PASSWORD to CONFIRMED, so the next login
    #    doesn't see a "New password required" challenge.
    aws cognito-idp admin-set-user-password \
        --region "$REGION" \
        --user-pool-id "$USER_POOL_ID" \
        --username "$email" \
        --password "$PASSWORD" \
        --permanent \
        >/dev/null
    echo "    permanent password set."

    # 4. Group membership. admin-add-user-to-group is idempotent on
    #    AWS's side (success even when already a member). We still
    #    list and prune any OTHER role groups so a previous seed
    #    misroute doesn't linger — e.g. if an operator switched
    #    owner@'s role from CUSTOMER → BUSINESS_OWNER by editing
    #    this script, the prune step removes the old CUSTOMER
    #    membership so deriveRole picks the new role cleanly.
    aws cognito-idp admin-add-user-to-group \
        --region "$REGION" \
        --user-pool-id "$USER_POOL_ID" \
        --username "$email" \
        --group-name "$group" \
        >/dev/null
    echo "    added to group $group."

    # Prune other role groups (CUSTOMER / BUSINESS_OWNER / ADMIN).
    current_groups="$(
        aws cognito-idp admin-list-groups-for-user \
            --region "$REGION" \
            --user-pool-id "$USER_POOL_ID" \
            --username "$email" \
            --query 'Groups[].GroupName' \
            --output json \
        | jq -r '.[]?'
    )"
    while IFS= read -r g; do
        [[ -z "$g" || "$g" == "$group" ]] && continue
        case "$g" in
            CUSTOMER|BUSINESS_OWNER|ADMIN)
                aws cognito-idp admin-remove-user-from-group \
                    --region "$REGION" \
                    --user-pool-id "$USER_POOL_ID" \
                    --username "$email" \
                    --group-name "$g" \
                    >/dev/null
                echo "    pruned stale group $g."
                ;;
        esac
    done <<<"$current_groups"

    # 5. Final status: confirm user is CONFIRMED + email_verified.
    status_json="$(
        aws cognito-idp admin-get-user \
            --region "$REGION" \
            --user-pool-id "$USER_POOL_ID" \
            --username "$email" \
            --output json
    )"
    user_status="$(echo "$status_json" | jq -r '.UserStatus')"
    email_verified="$(
        echo "$status_json" \
        | jq -r '.UserAttributes[] | select(.Name=="email_verified").Value'
    )"
    sub="$(
        echo "$status_json" \
        | jq -r '.UserAttributes[] | select(.Name=="sub").Value'
    )"
    echo "    status=$user_status email_verified=$email_verified sub=$sub"
}

for seed in "${SEEDS[@]}"; do
    IFS=';' read -r email display_name group <<<"$seed"
    upsert_user "$email" "$display_name" "$group"
    echo
done

echo "==> Done"
echo
echo "Sign in (mobile customer / business roles):"
echo "  Email   : <one of the three seeded addresses>"
echo "  Password: $PASSWORD"
echo
echo "Open the mobile app + tap Sign in. Cognito hosted UI shows;"
echo "type the email + password. LoginScreen completes phase-1"
echo "(token exchange) + phase-2 (POST /v1/auth/sync) and lands"
echo "on the authenticated shell. The backend users row is"
echo "created by UserService.syncFromPrincipal — role is derived"
echo "from the cognito:groups claim (precedence ADMIN >"
echo "BUSINESS_OWNER > CUSTOMER)."
echo
echo "Admin role: the ADMIN account drives the admin SPA (see"
echo "docs/operations/runbooks/dev-cognito-users.md). The mobile"
echo "app does not expose admin tools; ADMIN users see the same"
echo "three-tab nav as CUSTOMER — admin operations live in the"
echo "admin web UI per the Phase 9 Track 3.5 design note."
