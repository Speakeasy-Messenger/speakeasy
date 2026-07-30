-- Up Migration
--
-- Phase two of the replay-safety rollout. Migration 0024 first deployed the
-- tombstone-aware API and non-rejecting compatibility triggers. Every live API
-- instance now reserves an id and sets this transaction-local ownership marker
-- before inserting its relay payload. A writer without that marker is legacy;
-- reject its replay before its handler can repeat recipient fan-out or push.

CREATE OR REPLACE FUNCTION sync_message_delivery_tombstone()
RETURNS TRIGGER AS $$
DECLARE
  reservation_owner TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    reservation_owner :=
      current_setting('speakeasy.message_reservation_id', TRUE);

    IF EXISTS (
      SELECT 1
      FROM message_delivery_tombstones
      WHERE message_id = NEW.id
    ) THEN
      IF reservation_owner = NEW.id THEN
        RETURN NEW;
      END IF;

      RAISE EXCEPTION 'message id % is already reserved', NEW.id
        USING ERRCODE = '23505';
    END IF;

    INSERT INTO message_delivery_tombstones (message_id, expires_at, delivered)
    VALUES (NEW.id, NEW.expires_at, FALSE);
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

-- Down Migration
--
-- Restore phase one's non-rejecting mirror. The table and triggers belong to
-- migration 0024 and intentionally remain in place.

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
