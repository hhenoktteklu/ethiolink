-- EthioLink — migration 0012: admin_actions table.
--
-- Append-only audit log for every administrative write action. One
-- row per admin operation. Read by the admin dashboard ("what has
-- this admin done?", "what's been done to this business?") and by
-- compliance / support inquiries.
--
-- See docs/architecture/DATABASE_SCHEMA.md "admin_actions" for the
-- canonical column spec.
--
-- Design notes:
--   * **Append-only.** No `updated_at`, no `deleted_at`, no UPDATE or
--     DELETE paths in the repository. Once an admin action is
--     recorded it is permanent — the entire value of the table is
--     that it cannot be quietly rewritten. A bug that recorded the
--     wrong action gets fixed forward by a new row, not by editing
--     history. The table-level conventions in DATABASE_SCHEMA.md
--     ("soft-delete via `deleted_at` only where retention is
--     required") deliberately do NOT apply here — retention is
--     unconditional.
--
--   * **No CHECK on `action`.** The schema doc lists illustrative
--     values (`'APPROVE_BUSINESS'`, `'REJECT_BUSINESS'`,
--     `'FEATURE_BUSINESS'`, ...) but does not pin the set. Phase 5
--     ships a few admin actions; later phases will add more
--     (`SUSPEND_USER`, `RESTORE_USER`, etc.) and we don't want every
--     new action to require a CHECK-altering migration. The
--     application layer owns the enum.
--
--   * **`target_id` is `uuid NOT NULL` without a foreign key.** The
--     target can point at multiple parent tables (`business_profiles`,
--     `users`, `business_categories`, ...) so a single FK isn't
--     possible. `target_type` is the polymorphic discriminator; the
--     application layer validates that `(target_type, target_id)`
--     resolves to a real row at write time. Soft constraint by
--     design — preserves audit integrity even if a target row is
--     later hard-deleted (rare; most targets are soft-deleted).
--
--   * **`admin_user_id` has `ON DELETE RESTRICT`.** Deleting an admin
--     user is gated on their audit history being moved or archived
--     first. In practice MVP soft-deletes via `users.status =
--     'DELETED'`, which leaves the FK chain intact. The RESTRICT is
--     the belt-and-braces guarantee that an admin's actions outlive
--     their account.
--
--   * **Indexes** match the two documented read paths from
--     PHASE_5_ADMIN_DASHBOARD.md:
--     - `(admin_user_id, created_at DESC)` — "what has admin X done
--       recently". Used by an admin-detail view and any future
--       per-admin audit export.
--     - `(target_type, target_id, created_at DESC)` — "what's been
--       done to entity Y". Used by the business-detail page to
--       render the rejection-notes / suspension history alongside
--       the row, and by every "show audit trail for this user" path.
--
--   * **No `set_updated_at` trigger.** Append-only — no UPDATE
--     surface, so no trigger required.
--
--   * **Retention.** Indefinite in MVP. The row size is small (one
--     uuid + four short text fields + a timestamp) and reads are
--     rare relative to writes; a busy marketplace with 100 admin
--     actions per day fills a single 8 KB page every few weeks. A
--     retention policy (archive to S3 + truncate older than N years)
--     can land as a Phase 8 hardening item if/when compliance
--     requires it. No application-layer purge in scope.

BEGIN;

CREATE TABLE admin_actions (
    id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id   uuid          NOT NULL
        REFERENCES users (id) ON DELETE RESTRICT,
    action          text          NOT NULL,
    target_type     text          NOT NULL,
    target_id       uuid          NOT NULL,
    notes           text,
    created_at      timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX admin_actions_admin_created_idx
    ON admin_actions (admin_user_id, created_at DESC);

CREATE INDEX admin_actions_target_created_idx
    ON admin_actions (target_type, target_id, created_at DESC);

COMMIT;
