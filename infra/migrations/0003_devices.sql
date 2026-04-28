-- Up Migration
--
-- Phase 4 (April 2026): multi-device support. A single Speakeasy user
-- (their adjective-adjective-noun id) can have N enrolled devices, each
-- identified by an opaque Vouchflow `device_token`. Server tracks the
-- mapping so:
--   - WS fan-out delivers to every live device of each recipient
--   - Push notifications target a specific device's push token
--   - Channel-key envelopes (spec §4b) get re-issued for each new device
--
-- A device is implicitly enrolled the first time the server sees its
-- `device_token` in a successful WS auth handshake (or `/v1/enroll`
-- equivalent). Vouchflow's binding between device_token and user_id is
-- the source of truth; the server simply records observed pairings.

CREATE TABLE devices (
  device_token  TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** FCM token (Android) or APNs token (iOS), set by client after registration. */
  push_token    TEXT,
  /** Platform — affects push routing. */
  platform      TEXT,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (platform IS NULL OR platform IN ('ios', 'android'))
);

CREATE INDEX devices_user_idx ON devices(user_id);

-- Down Migration

DROP INDEX IF EXISTS devices_user_idx;
DROP TABLE IF EXISTS devices;
