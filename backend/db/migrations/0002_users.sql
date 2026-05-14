-- EthioLink — migration 0002: users table.
--
-- Mirrors Cognito identities. One row per authenticated principal, across
-- all three application roles. See docs/architecture/DATABASE_SCHEMA.md
-- "users" for the canonical column spec.
--
-- Design notes:
--   * `cognito_sub` is the only externally-supplied unique identifier. Every
--     other row in the system references `users.id` (a generated uuid), not
--     the Cognito sub, so we can swap identity providers later without
--     rewriting foreign keys.
--   * `email` is `citext` so "Henok@..." and "henok@..." cannot exist as two
--     separate accounts. Email and phone are individually nullable because a
--     user may sign up with either one; Cognito enforces uniqueness of each
--     alias at the auth layer, so we do not duplicate that constraint here.
--   * Role / status use Postgres CHECK constraints rather than ENUM types,
--     per the project-wide convention (cheap migrations beat strict typing).
--   * The `set_updated_at()` trigger function is defined here for the first
--     time and re-used by later migrations. Without it, `updated_at` would
--     never change after INSERT and the column would be useless.

BEGIN;

-- Shared trigger function: stamp updated_at on every row UPDATE.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TABLE users (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    cognito_sub  text        NOT NULL UNIQUE,
    email        citext,
    phone        text,
    role         text        NOT NULL
        CHECK (role IN ('CUSTOMER', 'BUSINESS_OWNER', 'ADMIN')),
    status       text        NOT NULL DEFAULT 'ACTIVE'
        CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
    display_name text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

COMMIT;
