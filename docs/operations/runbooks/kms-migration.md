# Runbook — Customer-managed KMS migration

This runbook moves an EthioLink environment's data at rest from AWS-managed encryption keys to the customer-managed KMS keys (CMKs) provisioned by `infra/terraform/modules/kms/`. The Terraform wiring (`Phase 9: add KMS module` + `Phase 9: wire CMKs through consumers`) is already in place — new writes after that apply encrypt under the CMK. This runbook is for the **existing-data move**: re-encrypting the RDS instance's storage, the S3 buckets' historical objects, and cycling the Secrets Manager secret versions onto the new key.

**Run in dev first.** The dev cutover is the rehearsal for prod — every step below has a dev-first checkpoint. Do not run in prod without a clean dev pass and an operator-signed checklist.

**Owner.** Operations + Security. Engineering on standby for IAM / runtime escalations.

**Estimated wall-clock.** Dev: 90 minutes (smaller dataset, no proxy, single-AZ). Prod: 2–3 hours, of which 10–20 minutes is the RDS read-only cutover; everything else is online.

## 0. Pre-flight checklist

Tick every box before touching any AWS resource. If any check fails, stop and triage.

- [ ] **Terraform plan review.** Run `terraform plan` against the target environment from `infra/terraform/environments/<env>/`. The expected diff is documented in `docs/architecture/AWS_DEPLOYMENT.md` § "KMS posture" → "What the wiring commit does NOT do". No unexpected `Replace` actions. The `aws_db_instance.this` `kms_key_id` will show as drift indefinitely until step 3 completes — that's expected.
- [ ] **RDS pre-cutover snapshot.** Take a manual snapshot of the current DB instance and confirm it reaches `available` before continuing.
  ```bash
  aws rds create-db-snapshot \
      --db-instance-identifier ethiolink-${ENV}-rds \
      --db-snapshot-identifier ethiolink-${ENV}-rds-pre-kms-$(date +%Y%m%d-%H%M)
  # Wait until status = available before proceeding.
  aws rds describe-db-snapshots \
      --db-snapshot-identifier ethiolink-${ENV}-rds-pre-kms-... \
      --query 'DBSnapshots[0].Status'
  ```
  This is the rollback artifact. Do not delete it until you've completed step 7 and the environment has been stable for 72 hours.
- [ ] **S3 object-count baselines.** Record the current object count + total size for each bucket. The re-encrypt step's `aws s3 cp` should preserve both — divergence is the early-warning signal.
  ```bash
  for b in media-public media-private logs admin-frontend; do
    echo "=== ethiolink-${ENV}-${b} ==="
    aws s3 ls --recursive --summarize "s3://ethiolink-${ENV}-${b}/" | tail -2
  done
  ```
  Capture the output into the runbook execution log.
- [ ] **Secrets Manager current versions.** Record the version stage labels currently attached to each EthioLink secret.
  ```bash
  for s in $(aws secretsmanager list-secrets \
        --query "SecretList[?starts_with(Name, 'ethiolink/${ENV}/')].Name" \
        --output text); do
    echo "=== $s ==="
    aws secretsmanager describe-secret --secret-id "$s" \
        --query '{Name:Name,KmsKeyId:KmsKeyId,VersionIds:VersionIdsToStages}'
  done
  ```
  Confirm one `AWSCURRENT` per secret. Note the existing `KmsKeyId` (should be empty / `null` if the secret is still on the AWS-managed key).
- [ ] **Lambda smoke baseline.** Run the existing smoke before any change — the post-cutover smoke must match.
  ```bash
  INVOKE_URL=$(terraform output -raw api_gateway_invoke_url) \
  REMINDER_FUNCTION_NAME=ethiolink-${ENV}-scheduled-send-reminders \
      bash backend/scripts/smoke.sh
  ```
  All three steps must return green.
- [ ] **CloudWatch alarm SNS topic confirmed.** Phase 7's alarms email the operator on Lambda errors / RDS storage burst / 5xx spikes — make sure the SNS subscription is confirmed so a cutover-induced failure pages someone.
- [ ] **Maintenance window scheduled.** Dev: any weekday morning is fine. Prod: a Saturday 06:00–09:00 Addis Ababa (03:00–06:00 UTC) window matches the existing RDS maintenance window and avoids peak booking traffic.
- [ ] **Rollback artifacts staged.** The pre-snapshot from above + the current `terraform.tfstate` backup in the state bucket. Confirm `aws s3 ls s3://ethiolink-tfstate-${ENV}/state/` lists today's version.

## 1. RDS re-encryption

AWS does **not** support an in-place `kms_key_id` swap on an existing `aws_db_instance`. The supported path is: snapshot → copy snapshot under the new CMK → restore from the copied snapshot → cutover application traffic. The new instance keeps the same engine + parameter group + subnet group + security group as the original.

### 1a. Copy the snapshot under the new CMK

```bash
RDS_CMK_ARN=$(terraform output -json kms_key_arns | jq -r .rds)

aws rds copy-db-snapshot \
    --source-db-snapshot-identifier ethiolink-${ENV}-rds-pre-kms-$STAMP \
    --target-db-snapshot-identifier ethiolink-${ENV}-rds-cmk-$STAMP \
    --kms-key-id "$RDS_CMK_ARN" \
    --copy-tags
```

AWS supports `--kms-key-id` on `copy-db-snapshot` even when the source snapshot is under an AWS-managed key. The copy is the re-encryption step — it produces a snapshot whose underlying storage is encrypted under the new CMK.

Wait for the copy to reach `available` (10–30 minutes depending on size):

```bash
aws rds describe-db-snapshots \
    --db-snapshot-identifier ethiolink-${ENV}-rds-cmk-$STAMP \
    --query 'DBSnapshots[0].{Status:Status,Kms:KmsKeyId,Size:AllocatedStorage}'
```

### 1b. Restore a new DB instance from the copied snapshot

The restore creates a new instance with a different `DBInstanceIdentifier`. Use a `-cmk` suffix so the existing instance keeps its name until the cutover.

```bash
aws rds restore-db-instance-from-db-snapshot \
    --db-instance-identifier ethiolink-${ENV}-rds-cmk \
    --db-snapshot-identifier ethiolink-${ENV}-rds-cmk-$STAMP \
    --db-subnet-group-name $(aws rds describe-db-instances \
        --db-instance-identifier ethiolink-${ENV}-rds \
        --query 'DBInstances[0].DBSubnetGroup.DBSubnetGroupName' \
        --output text) \
    --vpc-security-group-ids $(aws rds describe-db-instances \
        --db-instance-identifier ethiolink-${ENV}-rds \
        --query 'DBInstances[0].VpcSecurityGroups[0].VpcSecurityGroupId' \
        --output text) \
    --db-parameter-group-name ethiolink-${ENV}-postgres15 \
    --multi-az ${MULTI_AZ:-false} \
    --no-publicly-accessible \
    --deletion-protection \
    --copy-tags-to-snapshot
```

Restoration runs ~15–25 minutes. The new instance has its own endpoint hostname (`ethiolink-${env}-rds-cmk.<random>.<region>.rds.amazonaws.com`); the application is not yet pointed at it.

### 1c. Cutover — point Lambda env + Terraform state at the new instance

This is the read-only window. Sequence:

1. **Quiesce writes.** Briefly disable EventBridge's `scheduled-send-reminders` rule + any business owner accepting bookings should be informed (prod only). Customer reads continue against the old endpoint.
   ```bash
   aws events disable-rule --name $(terraform output -raw eventbridge_rule_arn | awk -F/ '{print $NF}')
   ```
2. **Verify the new instance is consistent.** Connect via `psql` from the bastion (or `aws lambda invoke` against the migration runner pointed at the new endpoint) and run a row-count baseline against `appointments`, `users`, `businesses`. Compare against the same query on the old endpoint.
3. **Re-import the resource in Terraform.** Two paths — pick one:
   - **Option A (recommended for dev): `terraform import`.** Remove the old `aws_db_instance.this` from state, import the new one under the same module address. Update the `identifier` local in the `rds` module to `ethiolink-${env}-rds-cmk` and commit the change so future plans don't re-rename.
     ```bash
     cd infra/terraform/environments/${ENV}
     terraform state rm 'module.rds.aws_db_instance.this'
     terraform import 'module.rds.aws_db_instance.this' ethiolink-${ENV}-rds-cmk
     terraform plan  # should show no drift on the new instance
     ```
   - **Option B (recommended for prod): rename the new instance to the original name.** Delete the old instance (after a final manual snapshot — `--final-snapshot-identifier`), then rename `ethiolink-${env}-rds-cmk` to `ethiolink-${env}-rds`. Terraform sees the original resource still under its original name. This avoids any module-config change.
     ```bash
     aws rds delete-db-instance \
         --db-instance-identifier ethiolink-${ENV}-rds \
         --final-db-snapshot-identifier ethiolink-${ENV}-rds-pre-decom-$STAMP \
         --no-skip-final-snapshot
     # Wait for deletion to complete (~5–10 min). Then rename.
     aws rds modify-db-instance \
         --db-instance-identifier ethiolink-${ENV}-rds-cmk \
         --new-db-instance-identifier ethiolink-${ENV}-rds \
         --apply-immediately
     ```
4. **Force the Lambdas to pick up the new endpoint.** Even after the rename the application Lambdas may have a cached DNS entry; the safest knob is a `terraform apply` which re-publishes Lambda env vars (in case the endpoint embedded there changed) and forces a fresh source-code-hash on every function.
5. **Re-enable EventBridge** and verify the next scheduled-reminder invocation against the new endpoint.
   ```bash
   aws events enable-rule --name <rule-name>
   ```

**Expected read-only window: 10–20 minutes** (Option A is slower because of the manual `terraform import`; Option B is faster but requires the original-instance delete to complete first).

### 1d. Rollback path

If the new instance shows a problem:

1. Re-point Terraform at the pre-snapshot. Edit `module "rds"` to add `snapshot_identifier = "ethiolink-${env}-rds-pre-kms-${STAMP}"` on a branch.
2. `terraform apply` provisions a fresh instance from the pre-snapshot under the AWS-managed key.
3. Re-route Lambda env to the rollback instance via the existing `terraform apply` flow.
4. Delete the failed CMK-encrypted instance.

The pre-snapshot is the single point of truth — do not delete it for at least 72 hours after a successful cutover.

## 2. S3 re-encryption

S3 applies `aws_s3_bucket_server_side_encryption_configuration` to **new** writes only. Existing objects keep whatever encryption they were uploaded with. The migration is `aws s3 cp s3://bucket/ s3://bucket/ --recursive --metadata-directive REPLACE`, which re-uploads every object with the new default SSE.

### 2a. Per-bucket re-encryption

Run one bucket at a time so a failure stops the run cleanly. Read `--sse-kms-key-id` from the Terraform output:

```bash
MEDIA_KEY=$(terraform output -json kms_key_arns | jq -r .s3_media)
LOGS_KEY=$(terraform output -json kms_key_arns | jq -r .s3_logs)
ADMIN_KEY=$(terraform output -json kms_key_arns | jq -r .s3_admin_frontend)
```

**Public media bucket** — every object becomes SSE-KMS under the media CMK:

```bash
aws s3 cp \
    s3://ethiolink-${ENV}-media-public/ \
    s3://ethiolink-${ENV}-media-public/ \
    --recursive \
    --metadata-directive REPLACE \
    --sse aws:kms \
    --sse-kms-key-id "$MEDIA_KEY"
```

**Private media bucket** — same:

```bash
aws s3 cp \
    s3://ethiolink-${ENV}-media-private/ \
    s3://ethiolink-${ENV}-media-private/ \
    --recursive \
    --metadata-directive REPLACE \
    --sse aws:kms \
    --sse-kms-key-id "$MEDIA_KEY"
```

**Logs bucket** — careful: in-flight log writes will continue arriving during the copy. Run with an `--exclude` covering the last hour so a midway log object doesn't get re-encrypted under the new key while the source bucket's logging service is still writing under the old default. Alternative: pause logging for the duration via the bucket's logging configuration; restore after.

```bash
# Estimate: prefix for objects older than today is safe to re-encrypt.
aws s3 cp \
    s3://ethiolink-${ENV}-logs/ \
    s3://ethiolink-${ENV}-logs/ \
    --recursive \
    --metadata-directive REPLACE \
    --sse aws:kms \
    --sse-kms-key-id "$LOGS_KEY" \
    --exclude "$(date +%Y-%m-%d)/*"
# After the bulk run, re-encrypt today's prefix in a second pass once
# the bulk copy completes (typically a few minutes of accumulated logs).
```

**Admin frontend bucket** — every object:

```bash
aws s3 cp \
    s3://ethiolink-${ENV}-admin-frontend/ \
    s3://ethiolink-${ENV}-admin-frontend/ \
    --recursive \
    --metadata-directive REPLACE \
    --sse aws:kms \
    --sse-kms-key-id "$ADMIN_KEY"
# After the copy, invalidate the CloudFront distribution so the next
# viewer request picks up the new encryption envelope (CloudFront
# caches ETags; the re-encrypt changes the underlying envelope but
# not the body, so the cached headers remain consistent — still,
# an invalidation is the belt-and-braces).
aws cloudfront create-invalidation \
    --distribution-id $(terraform output -raw admin_frontend_distribution_id) \
    --paths '/*'
```

### 2b. Verification

After each bucket, sample five objects and confirm `SSEKMSKeyId` is set:

```bash
aws s3api list-objects-v2 \
    --bucket ethiolink-${ENV}-media-public \
    --max-items 5 \
    --query 'Contents[].Key' --output text \
| xargs -n1 -I{} aws s3api head-object \
    --bucket ethiolink-${ENV}-media-public \
    --key {} \
    --query '{Key:Metadata.x-amz-meta-original-key,SSE:ServerSideEncryption,KmsKey:SSEKMSKeyId}'
```

Every row should show `ServerSideEncryption=aws:kms` and a `SSEKMSKeyId` matching `$MEDIA_KEY`.

### 2c. Rollback path

S3 re-encryption is reversible: flip the bucket SSE config back to `AES256` in Terraform (set the matching `*_kms_key_arn` env-stack input back to `null`) and re-run `aws s3 cp ... --sse AES256 --metadata-directive REPLACE`. The previous AWS-managed key remains valid; existing objects keep their previous envelope. There is no data loss path.

## 3. Secrets Manager re-encryption

The `aws_secretsmanager_secret` Terraform `kms_key_id` change set the **encryption configuration** for new versions; the existing `AWSCURRENT` and `AWSPREVIOUS` versions remain under the old key. Re-encrypting cycles a new version under the CMK.

### 3a. Force a rotation

For the RDS master secret, trigger the existing SAR rotation Lambda:

```bash
aws secretsmanager rotate-secret \
    --secret-id ethiolink/${ENV}/rds/master
```

The four-step rotation runs in seconds. After completion:

- `AWSCURRENT` → new version encrypted under the CMK.
- `AWSPREVIOUS` → old version still under the AWS-managed key (Secrets Manager keeps it valid for ~24 hours so warm Lambda containers holding the old password still authenticate).

### 3b. Put-secret alternative for non-rotating secrets

For secrets without a rotation Lambda (future SMS / Telegram API keys, when they land), trigger a no-op `put-secret-value`:

```bash
aws secretsmanager get-secret-value \
    --secret-id ethiolink/${ENV}/<name> \
    --query 'SecretString' --output text \
| aws secretsmanager put-secret-value \
    --secret-id ethiolink/${ENV}/<name> \
    --secret-string file:///dev/stdin
```

The new version is identical content but encrypted under the CMK.

### 3c. Verification

```bash
aws secretsmanager describe-secret \
    --secret-id ethiolink/${ENV}/rds/master \
    --query '{Name:Name,KmsKeyId:KmsKeyId,Current:VersionIdsToStages}'
```

`KmsKeyId` should equal the CMK ARN. The new version id should carry the `AWSCURRENT` label.

### 3d. Rollback path

Set the `aws_secretsmanager_secret.master.kms_key_id` back to `null` via the env-stack input and `terraform apply`. The next rotation cycles a new version under the AWS-managed key. No data move needed — the secret's value remains identical, only the envelope key changes.

## 4. Lambda env-var re-encryption

This step has already happened: the `Phase 9: wire CMKs through consumers` `terraform apply` set `kms_key_arn` on every `aws_lambda_function.function`, and Lambda re-encrypted the env-var blob in place at that point. No explicit step required during this maintenance window.

### 4a. Verification

```bash
aws lambda list-functions \
    --query "Functions[?starts_with(FunctionName, 'ethiolink-${ENV}-')].[FunctionName,KMSKeyArn]" \
    --output table
```

Every function should report a non-empty `KMSKeyArn` matching `module.kms.lambda_env_key_arn`.

### 4b. Spot-check a per-domain role's KMS grant

```bash
aws iam list-role-policies \
    --role-name ethiolink-${ENV}-lambda-exec-auth
# Expected: 'ethiolink-dev-lambda-baseline-auth', 'ethiolink-dev-lambda-kms-secrets-auth'
aws iam get-role-policy \
    --role-name ethiolink-${ENV}-lambda-exec-auth \
    --policy-name ethiolink-${ENV}-lambda-kms-secrets-auth
# The policy document should include kms:Decrypt on the secrets CMK
# with a kms:ViaService = secretsmanager.<region>.amazonaws.com condition.
```

Repeat for the `media` role's `kms-media` policy.

## 5. End-to-end verification

Run after every step above completes.

### 5a. Resource-level checks

```bash
# RDS
aws rds describe-db-instances \
    --db-instance-identifier ethiolink-${ENV}-rds \
    --query 'DBInstances[0].{Id:DBInstanceIdentifier,Kms:KmsKeyId,Endpoint:Endpoint.Address}'
# KmsKeyId should equal module.kms.rds_key_arn.

# S3 — bucket default SSE
for b in media-public media-private logs admin-frontend; do
  echo "=== ethiolink-${ENV}-${b} ==="
  aws s3api get-bucket-encryption --bucket ethiolink-${ENV}-${b} \
      --query 'ServerSideEncryptionConfiguration.Rules[0]'
done
# Each block should show SSEAlgorithm=aws:kms + KMSMasterKeyID set.

# S3 — sample object-level encryption
aws s3api head-object \
    --bucket ethiolink-${ENV}-media-public \
    --key $(aws s3 ls --recursive s3://ethiolink-${ENV}-media-public/ | head -1 | awk '{print $NF}') \
    --query '{SSE:ServerSideEncryption,Key:SSEKMSKeyId}'

# Secrets Manager
aws secretsmanager describe-secret \
    --secret-id ethiolink/${ENV}/rds/master \
    --query '{KmsKeyId:KmsKeyId,Current:VersionIdsToStages}'

# Lambda env
aws lambda get-function-configuration \
    --function-name ethiolink-${ENV}-categories-list \
    --query 'KMSKeyArn'
```

### 5b. Application smoke

Re-run the standard smoke. It must match the pre-flight baseline:

```bash
INVOKE_URL=$(terraform output -raw api_gateway_invoke_url) \
REMINDER_FUNCTION_NAME=ethiolink-${ENV}-scheduled-send-reminders \
    bash backend/scripts/smoke.sh
```

All three steps must return green. If `GET /v1/categories` fails with a 5xx, check CloudWatch Logs for `KMS AccessDenied` errors on the `categories-list` function — usually a missing `kms:Decrypt` grant on the secrets CMK (the cold-start `loadSecretsThenConfig` path).

### 5c. Booking happy path (manual)

Sign in to the admin SPA, navigate to a `PENDING_REVIEW` business, approve it. Then sign in to the mobile app (via TestFlight or a dev build), create an appointment for that business, accept it from the admin SPA, mark complete. Every step exercises a different Lambda + RDS read + RDS write + (optionally) S3 read.

## 6. Dev-first execution notes

- Run the entire runbook in dev end-to-end before scheduling prod. The dev RDS instance is small (`db.t4g.small`, 20 GiB) — the snapshot copy completes in ~5 minutes; the restore in ~10 minutes.
- The dev `prevent_destroy = true` on `aws_db_instance.this` does **not** apply to the rebuilt instance because the rebuild path is `delete + restore`, not in-place modify. Confirm the dev RDS deletion-protection setting (`true` by default — set on the new instance via `--deletion-protection` in the restore call).
- The dev cutover does not have a real customer impact; use it to time the read-only window so the prod operator can communicate a realistic ETA.
- Update the runbook with any dev-discovered surprises before the prod run.

## 7. Prod maintenance window notes

- Schedule a Saturday 06:00–09:00 Addis Ababa (03:00–06:00 UTC) window — matches the existing RDS maintenance window. Customers see no impact during this period in practice (booking volume is near-zero overnight).
- Send a customer-facing notice 24 hours before the window: "EthioLink will be temporarily read-only between 06:00–07:00 EAT on Saturday for scheduled maintenance. Booking the night before or the afternoon of remains available."
- Run with two operators on the bridge: one driving the AWS CLI, one watching CloudWatch dashboards + the alarms SNS topic.
- Capture every command output to the runbook execution log file. The Phase 8 DR runbook's log-capture pattern (`script -L /tmp/kms-migration-prod-$STAMP.log`) is the recommended shape.
- The prod path uses **Option B (rename)** from § 1c — avoids any `terraform import` mid-window and minimizes drift risk on the in-progress apply.
- Post-cutover: monitor for 60 minutes before declaring the maintenance window closed. Watch the API Gateway 5xx alarm, the per-Lambda error rate dashboards, and the RDS connection-count graph (a sudden drop is bad — likely cached endpoint pointing at the deleted instance).
- Keep the pre-snapshot for at least 72 hours after the window closes.

## 8. Known risks

### R1 — RDS endpoint change + cached Lambda env

**Risk.** Option A from § 1c changes the instance endpoint hostname (`ethiolink-${env}-rds-cmk.<random>...`). Application Lambdas embed the old endpoint in their env vars; warm containers keep using the cached value until they're recycled. AWS recycles warm containers within ~15 minutes of an env-var change, but a Lambda that hasn't been invoked recently will hold the old endpoint indefinitely.

**Mitigation.** Option B (the prod path) renames the new instance to the original name, which keeps the existing DNS record valid; warm containers see no change. If Option A is used in dev, `terraform apply` after the import forces a `source_code_hash` change on every function, which recycles all warm containers in the next invocation. Acceptable in dev; not acceptable in prod.

### R2 — S3 KMS cost

**Risk.** SSE-KMS adds per-request KMS API costs (~$0.03 per 10K KMS requests). At MVP scale this is single-digit dollars per month, but a misconfigured `bucket_key_enabled = false` would push it to dozens.

**Mitigation.** The Terraform wiring already sets `bucket_key_enabled = true` on every bucket whose SSE flips to KMS. Verify after apply via:

```bash
aws s3api get-bucket-encryption --bucket ethiolink-${ENV}-media-public \
    --query 'ServerSideEncryptionConfiguration.Rules[0].BucketKeyEnabled'
# Expected: true
```

### R3 — IAM `AccessDenied` on first call after the swap

**Risk.** A missing `kms:Decrypt` grant on a per-domain Lambda role surfaces as a 5xx on the first request after the swap. The most likely culprit is a domain that uses Secrets Manager-encrypted secrets (every domain, via the RDS master secret) but whose IAM role didn't get the matching `lambda_kms_secrets` policy attached.

**Mitigation.** The wiring commit attaches the policy to every per-domain role (count-gated on `secrets_kms_key_arn != null`); the dev cutover verifies it for every function. If a 5xx appears in prod post-cutover, check CloudWatch Logs for `KMS.AccessDeniedException` lines. The fix is to manually attach the missing policy via `aws iam put-role-policy` while Terraform catches up.

### R4 — SAR rotation Lambda KMS permissions

**Risk.** The SAR-deployed rotation Lambda has its own execution role (created by CloudFormation, not Terraform). When the RDS master secret flips to the CMK, the rotation Lambda needs `kms:Decrypt` on that key — otherwise the next rotation fails partway through and the secret may end up in a `PENDING` state.

**Mitigation.** The `secrets` module's `aws_iam_role_policy.rotation_kms` (added in the wiring commit) attaches this grant when `var.secrets_kms_key_arn` is non-null. Verify post-apply:

```bash
ROTATION_ROLE=$(aws lambda get-function-configuration \
    --function-name ethiolink-${ENV}-rds-rotation \
    --query 'Role' --output text | awk -F/ '{print $NF}')
aws iam list-role-policies --role-name "$ROTATION_ROLE"
# Expected to include: ethiolink-${env}-rds-rotation-kms-decrypt
```

After the secret flips, trigger one manual rotation (§ 3a) and watch the rotation Lambda's CloudWatch Logs for completion.

### R5 — Pre-snapshot deletion before stability is confirmed

**Risk.** The pre-snapshot is the single rollback artifact. Deleting it too soon makes recovery impossible.

**Mitigation.** Tag the pre-snapshot with `Lifecycle=Retain-72h` + a `KeepUntil=YYYY-MM-DD` tag. Schedule a calendar reminder to delete it manually after the 72-hour stability window.

### R6 — `aws s3 cp` mid-flight failure on the logs bucket

**Risk.** The logs bucket receives in-flight writes from the source media buckets' logging configuration. If the `aws s3 cp` copy hits a newly-written object that's still being uploaded, the copy may succeed but produce a truncated re-encrypted version.

**Mitigation.** Use the `--exclude "$(date +%Y-%m-%d)/*"` flag (already in § 2a's logs step) to skip today's prefix during the bulk run. Re-encrypt today's prefix in a second pass after the bulk completes. Alternatively, pause logging on the source buckets via `aws_s3_bucket_logging` for the duration of the copy and restore after.

## 9. Operator sign-off

Mark each step in the order it was completed. The two-operator pattern is the bridge: one drives, the other ticks the box + records the timestamp + the verification command output in the execution log.

- [ ] Pre-flight checklist complete (§ 0)
- [ ] RDS pre-snapshot created and verified `available` (§ 0)
- [ ] RDS re-encryption complete; new instance carries the CMK; smoke passes (§ 1)
- [ ] S3 re-encryption complete on all four buckets; sample objects show `SSEKMSKeyId` (§ 2)
- [ ] Secrets Manager rotation triggered; `AWSCURRENT` under CMK (§ 3)
- [ ] Lambda env-vars verified under CMK (§ 4)
- [ ] End-to-end smoke + booking happy path green (§ 5)
- [ ] Post-cutover 60-minute monitoring window clean (§ 7, prod only)
- [ ] Pre-snapshot retained for 72 hours; calendar reminder set (§ 8 R5)

Owner signature:  ______________________   Date:  ____________

Operations witness:  ___________________   Date:  ____________
