-- Up Migration
--
-- Generic structured event log for server-side diagnostics. Stdout
-- logs are great for "what's happening right now" but fly's log
-- buffer aged out tester5's push event after ~5 minutes, leaving no
-- way to answer "did the server push to this user 20 minutes ago?"
--
-- This table is the persistent answer for THAT class of question:
--   - Push notify attempts (rc.55 added the stdout log; this is its
--     durable shadow)
--   - Future: WS auth, ack routing, anything where "was this user
--     reached, and when" is the diagnostic question
--
-- Not a general log shipper — only paths that explicitly call
-- recordEvent() land here. Keeps the table volume bounded.
--
-- Retention: nothing automatic for now. The push-attempt cardinality
-- is small enough (a few per active user per minute peak) that this
-- table will stay tiny for the alpha. If volume grows we can add a
-- 30-day cron prune.

CREATE TABLE server_event_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  event_type TEXT NOT NULL,
  user_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX server_event_log_user_ts ON server_event_log(user_id, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX server_event_log_type_ts ON server_event_log(event_type, ts DESC);

-- Down Migration

DROP TABLE IF EXISTS server_event_log;
