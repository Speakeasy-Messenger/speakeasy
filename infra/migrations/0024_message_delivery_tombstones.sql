-- Up Migration
--
-- Reserve client-supplied message ids independently from relay payload rows.
-- Confirmed delivery still deletes the `messages` row immediately, preserving
-- the server-retention contract. This table retains only the opaque id, its
-- normal seven-day relay expiry, and whether a replay should receive another
-- `delivered` receipt.

CREATE TABLE message_delivery_tombstones (
  message_id TEXT PRIMARY KEY,
  expires_at TIMESTAMPTZ NOT NULL,
  delivered  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX message_delivery_tombstones_expires_idx
  ON message_delivery_tombstones(expires_at);

-- Phase one of the rolling deploy must coexist with old instances that do not
-- know about the reservation table. Mirror their payload inserts and
-- confirmed-delivery deletes at the database boundary. This trigger
-- deliberately does not reject duplicates yet: the old async WebSocket
-- listener has no rejection boundary, so hard conflicts are enabled only by a
-- follow-up migration after every instance runs the tombstone-aware API.
CREATE OR REPLACE FUNCTION sync_message_delivery_tombstone()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO message_delivery_tombstones (message_id, expires_at, delivered)
    VALUES (NEW.id, NEW.expires_at, FALSE)
    ON CONFLICT (message_id) DO NOTHING;
    RETURN NEW;
  END IF;

  INSERT INTO message_delivery_tombstones (message_id, expires_at, delivered)
  VALUES (OLD.id, OLD.expires_at, TRUE)
  ON CONFLICT (message_id) DO UPDATE
    SET expires_at = EXCLUDED.expires_at,
        delivered = TRUE;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_tombstone_insert
BEFORE INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION sync_message_delivery_tombstone();

CREATE TRIGGER messages_tombstone_delete
AFTER DELETE ON messages
FOR EACH ROW EXECUTE FUNCTION sync_message_delivery_tombstone();

-- Install both triggers before backfilling. Their table locks are retained
-- until this transactional migration commits, so an old writer cannot insert
-- an untracked payload between the snapshot and trigger activation.
INSERT INTO message_delivery_tombstones (message_id, expires_at, delivered)
SELECT id, expires_at, delivered
FROM messages
ON CONFLICT (message_id) DO NOTHING;

-- Down Migration

DROP TRIGGER IF EXISTS messages_tombstone_delete ON messages;
DROP TRIGGER IF EXISTS messages_tombstone_insert ON messages;
DROP FUNCTION IF EXISTS sync_message_delivery_tombstone();
DROP TABLE IF EXISTS message_delivery_tombstones;
