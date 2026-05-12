-- Up Migration
--
-- Reconcile a long-standing schema vs. SQL drift: commit 8fcbcdb
-- ("fix(api): server tracks deviceToken→userId in user repo",
-- May 4) added `users.device_token` to apps/api/src/db/schema.ts and
-- queried it from `DrizzleUserRepo.findUserIdByDeviceToken`, but
-- never shipped a migration to add the column to the database.
--
-- The runtime got away with it for several alpha releases because
-- the deployed `dist/` was stale relative to schema.ts on those
-- builds; rebuilding `dist/` fresh in rc.7 surfaced the missing
-- column as `42703 column users.device_token does not exist` on
-- every authenticated request.
--
-- Idempotent path so this can re-apply safely against any environment
-- where the column was added out-of-band:
--   1. ADD COLUMN IF NOT EXISTS — nullable initially.
--   2. Backfill from `devices` (latest enrolled device per user) for
--      rows that have one. Pre-rc.6 alpha users will already be
--      represented in `devices` since `devices` has been populated by
--      the WS auth handshake since 0003.
--   3. DELETE users we still can't backfill — they're zombies that
--      can never authenticate and would fail the NOT NULL step.
--   4. SET NOT NULL on the column to match schema.ts contract.
--   5. Add the lookup index.

ALTER TABLE users ADD COLUMN IF NOT EXISTS device_token TEXT;

UPDATE users
SET device_token = (
  SELECT d.device_token
    FROM devices d
   WHERE d.user_id = users.id
   ORDER BY d.enrolled_at DESC
   LIMIT 1
)
WHERE device_token IS NULL;

DELETE FROM users WHERE device_token IS NULL;

ALTER TABLE users ALTER COLUMN device_token SET NOT NULL;

CREATE INDEX IF NOT EXISTS users_device_token_idx ON users (device_token);

-- Down Migration

DROP INDEX IF EXISTS users_device_token_idx;
ALTER TABLE users DROP COLUMN IF EXISTS device_token;
