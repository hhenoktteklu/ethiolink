# Dev Cognito user seeding

> **DEV ONLY.** The credentials in this runbook are hardcoded and committed to the repository. Run the script only against the **dev** Cognito user pool. The seeder explicitly refuses to run when the pool's `Name` attribute matches `*-prod-*` unless `ETHIOLINK_ALLOW_PROD_COGNITO_SEED=1` is set. Don't override that.

The script `backend/scripts/seed-dev-cognito-users.sh` creates and maintains three predictable accounts you can sign into during local + emulator development. Each account is bound to the matching Cognito group, so the backend `deriveRole` precedence picks the right `users.role` on first sign-in.

## Accounts

| Email                      | Display name   | Cognito group   | Role                       |
| -------------------------- | -------------- | --------------- | -------------------------- |
| `customer@ethiolink.test`  | Customer Demo  | `CUSTOMER`      | `CUSTOMER`                 |
| `owner@ethiolink.test`     | Owner Demo     | `BUSINESS_OWNER` | `BUSINESS_OWNER`          |
| `admin@ethiolink.test`     | Admin Demo     | `ADMIN`         | `ADMIN`                    |

**Shared password:** `EthioLinkDev@2026` (override with `--password`).

Status set by the seeder: `UserStatus=CONFIRMED`, `email_verified=true`, permanent password (no `FORCE_CHANGE_PASSWORD` prompt on first login).

The role derivation precedence is `ADMIN > BUSINESS_OWNER > CUSTOMER` (see `backend/shared/adapters/auth/AuthProvider.ts:deriveRole` and the existing test cases in `backend/tests/users/userService.test.ts:218`). Each seeded account is added to exactly one role group; the seeder also prunes the other two role groups on every run so a previous misroute doesn't linger.

## One-shot seeding

```sh
# Resolve the dev pool ID from terraform output.
POOL_ID=$(terraform -chdir=infra/terraform/environments/dev \
            output -raw cognito_user_pool_id)

bash backend/scripts/seed-dev-cognito-users.sh \
    --region eu-west-1 \
    --user-pool-id "$POOL_ID"
# or with an explicit password override:
bash backend/scripts/seed-dev-cognito-users.sh \
    --region eu-west-1 \
    --user-pool-id "$POOL_ID" \
    --password 'EthioLinkDev@2026'
```

The script is idempotent — safe to run repeatedly. Each invocation:

1. Calls `admin-create-user` with `--message-action SUPPRESS` so Cognito doesn't email the `.test` address. Existing users surface `UsernameExistsException`, which is caught and treated as success.
2. Calls `admin-update-user-attributes` to set `email_verified=true` and the `name` attribute (works on both freshly-created and pre-existing users).
3. Calls `admin-set-user-password --permanent` to (re)set the password and clear the `FORCE_CHANGE_PASSWORD` challenge state.
4. Calls `admin-add-user-to-group` for the intended group. AWS treats double-adds as success.
5. Calls `admin-list-groups-for-user` and `admin-remove-user-from-group` to prune the *other* role groups, so a previous run that assigned the wrong group can be corrected by editing the seed table in the script and rerunning.
6. Prints `UserStatus`, `email_verified`, and `sub` for each account on success.

## Mobile verification

After seeding, on an emulator with the app running (`flutter run -d emulator-5554 --dart-define-from-file=env/dev.json`):

1. **Customer.** Tap Sign in → enter `customer@ethiolink.test` / `EthioLinkDev@2026` in the Cognito hosted UI. After the callback, `LoginScreen` runs phase-2 (`POST /v1/auth/sync`) and lands on the three-tab shell (Browse / Bookings / Profile). The Bookings tab should render the empty state, not "User profile not found".
2. **Business owner.** Sign out (Profile → Sign out), then sign in as `owner@ethiolink.test`. The fourth tab "My Business" appears in the bottom nav (see Phase 9 Track 3.5 role gating in `mobile/lib/features/browse/browse_screen.dart`).
3. **Admin.** Sign out, sign in as `admin@ethiolink.test`. The mobile app intentionally shows the same three-tab nav as CUSTOMER for ADMIN principals — admin operations live in the admin SPA, not the mobile app, per the Phase 9 Track 3.5 design (see the comments in `browse_screen_test.dart`). To exercise the admin role:
   - Confirm `users.role` is `ADMIN` (see DB verification below).
   - Use the admin web SPA against the same Cognito user pool's `admin` app client.

## Backend `users` row verification

The `/v1/auth/sync` Lambda creates / updates the row by Cognito `sub`. After driving one sign-in per account:

```sh
# Substitute your dev RDS connection. The migration Lambda has the
# admin credentials in Secrets Manager — easiest path is to port-forward
# via the bastion documented in dev-migrations.md.
psql "$DEV_DB_URL" -c "
  SELECT email, role, status, display_name
    FROM users
   WHERE email LIKE '%@ethiolink.test'
   ORDER BY email;
"
```

Expected:

```
            email             |       role       | status |   display_name
------------------------------+------------------+--------+------------------
 admin@ethiolink.test         | ADMIN            | ACTIVE | Admin Demo
 customer@ethiolink.test      | CUSTOMER         | ACTIVE | Customer Demo
 owner@ethiolink.test         | BUSINESS_OWNER   | ACTIVE | Owner Demo
```

If `role` doesn't match the seeded group, inspect the ID token's `cognito:groups` claim on the mobile device (`adb logcat | grep auth.sync`) or check CloudWatch:

```sh
aws logs filter-log-events \
  --log-group-name /aws/lambda/ethiolink-dev-auth-sync \
  --start-time $(date -u -d "10 minutes ago" +%s000) \
  --filter-pattern '"user.sync"' --max-items 10
```

The handler logs `{ userId, sub, role }` per sync; that's the canonical record of what `deriveRole` returned for each principal.

## Removing the seeded accounts

There's no "unseed" command — these are dev fixtures intended to stick around for the life of the dev environment. To drop them ad-hoc:

```sh
for user in customer@ethiolink.test owner@ethiolink.test admin@ethiolink.test; do
    aws cognito-idp admin-delete-user \
        --region eu-west-1 \
        --user-pool-id "$POOL_ID" \
        --username "$user"
done
psql "$DEV_DB_URL" -c "DELETE FROM users WHERE email LIKE '%@ethiolink.test';"
```

Note the backend `users.cognito_sub` references `users.id` from `appointments` / `business_profiles` / etc. with `ON DELETE RESTRICT`. If a seeded user already has booked appointments or owned businesses, the `DELETE FROM users` will fail — clean those up first.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `aws: command not found` | AWS CLI missing | Install <https://aws.amazon.com/cli/> |
| `jq: command not found` | jq missing | `brew install jq` / `apt-get install jq` |
| `Refusing to seed users into "…-prod-…"` | Wrong pool ID supplied | Re-run terraform-output against `environments/dev` |
| `InvalidPasswordException` from `admin-set-user-password` | Password policy is stricter than the default | Re-run with `--password '<stronger>'` |
| `NotAuthorizedException` from `admin-*` calls | Caller IAM role lacks `cognito-idp:AdminCreateUser` etc. | Use an operator role (or the bootstrap IAM user) that has `cognito-idp:Admin*` on the dev pool |
| Mobile sign-in says "Your session expired" right after the hosted UI completes | Browser came back with an expired auth code (very stale Custom Tab) | Re-tap Sign in; the `LoginScreen` phase-1-failed CTA reissues the OAuth flow |
| Bookings tab still says "User profile not found" after sign-in | `POST /v1/auth/sync` didn't fire | Confirm the most recent app build includes the commit `Sync backend user profile after mobile sign-in`; verify with `aws logs filter-log-events --log-group-name /aws/lambda/ethiolink-dev-auth-sync` |
| `users.role` doesn't match the seeded group | The login happened BEFORE the seeder added the group | Re-run the seeder, sign out, sign back in — the second sign-in's ID token carries the updated `cognito:groups` and the upsert path corrects the role |
