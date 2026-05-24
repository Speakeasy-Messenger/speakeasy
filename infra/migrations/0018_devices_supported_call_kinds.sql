-- Up Migration
--
-- Per-device list of call kinds the device can answer. Sender's
-- mobile reads the UNION across the peer's connected devices
-- (`GET /v1/users/:id`) to preflight which CallTypeSheet rows to
-- show; server's WS fan-out (`call-router.ts`) consults the same
-- info live (in-memory `Connection.capabilities`) so a `kind:'private'`
-- offer never wakes a device that can't answer it.
--
-- Default ['audio','video'] matches the historical capability set
-- pre-rc.130 — old clients reconnecting without sending the new
-- `supported_call_kinds` auth field keep their existing reach.
-- Newer clients overwrite on every connect (so downgrades, e.g.
-- filter native module removed, shrink the set immediately).

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS supported_call_kinds TEXT[]
  NOT NULL DEFAULT ARRAY['audio', 'video'];

-- Down Migration
-- ALTER TABLE devices DROP COLUMN IF EXISTS supported_call_kinds;
