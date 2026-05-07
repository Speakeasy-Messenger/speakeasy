-- Per-device notification privacy preference. Drives FCM/APNs banner
-- copy: 'rich' surfaces sender handle, 'private' falls back to a
-- generic "speakeasy: New message". NULL is interpreted as 'rich' at
-- read-time (see DrizzleDevicesRepo.listForUser) so pre-Phase-5d-knob
-- rows don't silently default to private.
ALTER TABLE devices ADD COLUMN notification_privacy TEXT;
