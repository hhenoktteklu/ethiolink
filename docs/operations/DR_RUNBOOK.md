# EthioLink — Disaster Recovery Runbook

This is the playbook the operator on call follows when the primary RDS instance is lost or corrupted. The target end-to-end recovery time is **60 minutes** from "RDS lost" to "API serving from a restored database" — the Phase 8 acceptance criterion.

The procedure assumes the operator has working AWS credentials in `eu-west-1`, the repo checked out, and Terraform `1.6.6` on `PATH`. Every step lists its expected timing so the operator can see whether they're tracking the 60-minute budget.

## Pre-flight (≤ 3 min)

1. **Confirm the failure.** RDS-side outage symptoms: API 5xx alarm firing, `RDS CPU` / `connections` metrics flat-lined, `aws rds describe-db-instances --db-instance-identifier ethiolink-prod-rds` returns `Status: failed` (or 404 if the instance is actually gone).
2. **Open a bridge.** Page the on-call rotation per `RUNBOOK.md`. Start a shared doc; capture every command + timestamp.
3. **Freeze the deploy pipeline.** Comment on the latest `deploy-prod` run to pause further deploys until recovery completes:
   ```bash
   gh workflow disable deploy-prod.yml
   ```

## Step 1 — Identify the latest known-good snapshot (≤ 2 min)

RDS automated snapshots run daily during the configured backup window (22:00–23:00 UTC). Manual snapshots are taken at every Terraform `apply` that touches RDS (the `final_snapshot_identifier` produces one on destroy).

```bash
aws rds describe-db-snapshots \
    --db-instance-identifier ethiolink-prod-rds \
    --snapshot-type automated \
    --query 'reverse(sort_by(DBSnapshots, &SnapshotCreateTime))[:5].[DBSnapshotIdentifier,SnapshotCreateTime,Status]' \
    --output table
```

The list is newest-first; pick the most recent `available` snapshot. Capture its identifier — the rest of the runbook calls it `${SNAPSHOT_ID}`. If the most recent is `creating`, fall back to the previous one (typically 24 hours older).

**Sanity check on snapshot age.** If the freshest snapshot is older than 36 hours, alert leadership before restoring — data loss exceeds normal expectations and may justify pulling from the daily `pg_dump` archive instead (Phase 8 follow-up; not in this runbook yet).

## Step 2 — Restore from snapshot (≤ 25 min)

The cleanest path is a Terraform-driven restore: edit the prod RDS module input to point at the snapshot, apply, let Terraform create the new instance from the snapshot and re-point downstream resources. The `aws_db_instance` resource supports `snapshot_identifier`.

```bash
cd infra/terraform/environments/prod

# Edit `main.tf` — in the `module "rds"` block, add:
#     snapshot_identifier = "<SNAPSHOT_ID>"
# Commit on a `dr-restore` branch so the audit trail captures it.
git checkout -b dr-restore-$(date +%Y%m%d-%H%M)
$EDITOR main.tf

# Plan — verify Terraform's plan shows the instance being
# RECREATED from the snapshot, not destroyed and rebuilt empty.
terraform plan

# Apply.
terraform apply -auto-approve
```

RDS restore-from-snapshot takes ~15–25 minutes for the prod 100 GiB instance. Terraform's `apply` blocks until the instance reaches `available`.

**Critical decision: in-place vs. side-by-side.** The above is the in-place path — same identifier, new underlying instance. The alternative is a side-by-side restore (new identifier, fail forward by re-pointing Lambda env). In-place is the default because it keeps every other resource (DB subnet group, parameter group, security group attachments) intact. Side-by-side is the right call when the in-place restore itself fails (rare — usually means a corrupted snapshot, see "If restore fails" below).

## Step 3 — Re-point downstream resources (≤ 5 min)

If the in-place restore preserved the RDS endpoint hostname, no Lambda env updates are needed — the existing `effective_endpoint` already points correctly and the per-Lambda `PG_HOST` env var doesn't need to change.

If the restore produced a different endpoint (rare, only when restoring to a different identifier), update the Lambda env:

```bash
# Re-apply Terraform. The Lambda module reads `effective_endpoint`
# from `module.rds` and re-publishes the per-function env on every
# apply.
terraform apply -auto-approve
```

Verify:

```bash
aws lambda get-function-configuration \
    --function-name ethiolink-prod-businesses-list \
    --query 'Environment.Variables.PG_HOST' \
    --output text
# Should match the restored RDS endpoint or proxy endpoint.
```

## Step 4 — Run the migration runner (≤ 1 min)

Even though the snapshot includes the full schema, running the migration runner is the cheapest way to verify (a) the new instance is reachable from the VPC, (b) the master credentials still resolve correctly, and (c) any migrations applied after the snapshot was taken get applied to the restored instance.

```bash
aws lambda invoke \
    --function-name "$(terraform output -raw lambda_db_migrate_function_name)" \
    --cli-binary-format raw-in-base64-out \
    --payload '{}' \
    /tmp/migrate-response.json
cat /tmp/migrate-response.json
```

Expected response: `{"status": "success", "applied": [], "skipped": ["0001_init.sql", ..., "0013_notification_logs.sql"], "failed": [], "target": "..."}`. Every migration file in `skipped` means the snapshot already contained the schema. Anything in `applied` means migrations landed after the snapshot — that's expected for the recovery window.

If `status: "partial_failure"`, the runner stopped on a specific file — fix the schema mismatch by hand (the `failed[0].error` message names the SQL that errored) before proceeding.

## Step 5 — Smoke test (≤ 2 min)

```bash
INVOKE_URL=$(terraform output -raw api_gateway_invoke_url) \
REMINDER_FUNCTION_NAME=$(terraform output -raw lambda_scheduled_reminders_function_name) \
    bash backend/scripts/smoke.sh
```

The three assertions confirm: API Gateway reaches Lambda, Lambda reaches RDS, the seed data is intact (`/v1/categories` returns the four MVP categories), the Cognito authorizer is wired, and the scheduled-reminder cold-start path works end-to-end.

If smoke passes, you're recovered. Sustain a few minutes of green on the CloudWatch alarms before considering it stable.

## Step 6 — Restore steady-state (≤ 5 min)

1. **Re-enable the deploy pipeline:**
   ```bash
   gh workflow enable deploy-prod.yml
   ```
2. **Acknowledge alarms.** The CPU / connections / 5xx alarms will auto-recover once the API serves traffic; clear any acknowledged-but-still-alarming state via the CloudWatch console.
3. **Merge the `dr-restore-*` branch into `main`** so the `snapshot_identifier` (now stale — it points at the snapshot we already restored from) doesn't trip the next apply. Then, in a follow-up commit, REMOVE the `snapshot_identifier` line — Terraform will refuse to recreate the instance because of `prevent_destroy`, leaving the field as a no-op.
4. **Send a brief post-incident note** to the on-call channel with the total recovery time, the chosen snapshot id, and the migration-runner response. Schedule the formal post-mortem within 24 hours.

## Total expected timing

| Step                                | Budget       |
| ----------------------------------- | ------------ |
| Pre-flight                          | 3 min        |
| Identify latest snapshot            | 2 min        |
| Restore from snapshot               | 25 min       |
| Re-point Lambda env                 | 5 min        |
| Migration runner                    | 1 min        |
| Smoke test                          | 2 min        |
| Restore steady-state                | 5 min        |
| **Total**                           | **43 min**   |

This leaves a ~15-minute cushion under the 60-minute SLO for the inevitable unexpected step (missed snapshot, misconfigured access, slow restore).

## If the restore fails

Scenarios + fallbacks:

- **Snapshot is corrupted (`Status: failed` after restore starts).** Pick the next-most-recent snapshot in step 1 and re-run from step 2. Maximum incremental data loss: 24 hours.
- **Restore stuck in `creating` past 35 min.** AWS Support page (Severity 1 — production system down). Continue trying side-by-side restore from the snapshot before yours.
- **Migration runner returns `partial_failure` on a file that should already be applied.** Indicates a schema drift between snapshot and migration files. Identify the diff:
  ```bash
  # Connect to the restored instance via the bastion (prod-only)
  # or by temporarily exposing the RDS endpoint to a dev jumpbox.
  psql "$DATABASE_URL" -c "SELECT filename FROM schema_migrations ORDER BY filename;"
  # Compare against `ls backend/db/migrations/*.sql`.
  ```
  Manually `INSERT` the missing filename rows into `schema_migrations` so the runner skips them, OR roll back to a still-older snapshot.
- **Smoke test fails on `/v1/categories`.** Either the public route isn't reachable (API Gateway misconfigured — re-apply Terraform) or the seed data is missing (`aws lambda invoke` the `db-migrate` function with `payload {"seed": true}` once the seed runner is added; for now run `node backend/db/seed.mjs` against the restored instance from the bastion).
- **Smoke test fails on the Cognito authorizer (401 doesn't fire).** Cognito user pool wasn't lost (`prevent_destroy = true`), so this means the API Gateway authorizer references the wrong pool ARN. Re-apply Terraform.

## Post-incident

1. **Schedule a post-mortem within 24 hours.** Use the captured command log + timestamps as the timeline.
2. **Update this runbook** with anything that surprised the operator. The "If the restore fails" section is the most likely place for additions.
3. **Trigger a fresh manual snapshot** of the restored instance to give the next operator a known-clean recovery point:
   ```bash
   aws rds create-db-snapshot \
       --db-instance-identifier ethiolink-prod-rds \
       --db-snapshot-identifier "ethiolink-prod-post-dr-$(date +%Y%m%d-%H%M)"
   ```
4. **Run the next monthly `backup-verify.yml` workflow manually** to validate the restore path is healthy under the new snapshot lineage.

## Related

- `.github/workflows/backup-verify.yml` — monthly automated check that exercises the snapshot-discovery + restore-validity path without touching prod.
- `docs/operations/RUNBOOK.md` — general on-call playbook (Phase 8 follow-up).
- `docs/operations/SLOs.md` — the 60-minute DR SLO + the booking / browse availability targets (Phase 8 follow-up).
