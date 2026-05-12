-- Up Migration
--
-- Track why a device failed to register a push token so we can
-- diagnose "not receiving push" reports without needing the user
-- to manually check their diag log.
--
-- NULL = never attempted or succeeded.
-- Non-NULL = last failure reason from the client.
-- Cleared on next successful registration.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_push_error TEXT;

-- Down Migration
-- ALTER TABLE devices DROP COLUMN IF EXISTS last_push_error;
