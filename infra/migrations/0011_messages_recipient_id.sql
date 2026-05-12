-- Up Migration
--
-- Same class of schema-vs-SQL drift as 0010 (users.device_token):
-- `apps/api/src/db/schema.ts` declared `messages.recipientId` as
-- `text('recipient_id').notNull()` and the `listUndeliveredFor` query
-- filtered on it, but no migration ever added the column. This
-- bites every WS auth handshake — the `deliverBuffered` call after
-- the `authed` send blows up with `42703: column messages.recipient_id
-- does not exist`, the catch in handler.ts silently emits
-- `auth_failed` + closes 4004, and the client reconnects.
--
-- The `messages` table is currently empty (no user could authenticate
-- so no message could be inserted), so adding NOT NULL with no
-- backfill is safe. For future environments where rows might exist,
-- the migration adds the column nullable, leaves it empty for any
-- existing rows (which would be unrecoverable in the prior schema
-- anyway since they had no recipient binding), then sets NOT NULL.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_id TEXT;

-- Backfill is impossible — the prior schema had no way to identify
-- a recipient. Drop any rows that lack one (they're undeliverable).
DELETE FROM messages WHERE recipient_id IS NULL;

ALTER TABLE messages ALTER COLUMN recipient_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS messages_recipient_idx ON messages (recipient_id);

-- Down Migration

DROP INDEX IF EXISTS messages_recipient_idx;
ALTER TABLE messages DROP COLUMN IF EXISTS recipient_id;
