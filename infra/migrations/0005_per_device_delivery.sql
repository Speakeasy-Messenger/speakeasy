-- Up Migration
-- Phase 5f per-device buffered-delivery tracking.
--
-- Until now, the first device to ack a message deleted the row for ALL
-- other devices of the same recipient — a real bug for multi-device
-- users. Phase 4 introduced multi-device fan-out at the WS layer (one
-- recipient receives the same message on every live socket); this
-- migration extends the persistence layer to match.
--
-- target_devices: snapshot of recipient's known devices at insert time.
--   Empty (NULL or '{}') = legacy single-device shortcut: any single
--   ack deletes the row. Matches behaviour for first-time recipients
--   who had no devices on file when the message was sent.
--
-- delivered_to_devices: subset of target_devices that have acked. Row
--   is deleted only when delivered_to_devices @> target_devices. The
--   `delivered` event fires to the original sender at that point.

ALTER TABLE messages
  ADD COLUMN target_devices       TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN delivered_to_devices TEXT[] NOT NULL DEFAULT '{}';

-- Down Migration
-- ALTER TABLE messages
--   DROP COLUMN delivered_to_devices,
--   DROP COLUMN target_devices;
