-- Up Migration

-- Profile photos (users) and group avatars. Plaintext base64 JPEG,
-- ~256px square, ~30KB typical. Encryption with a per-user profile
-- key is a v2 effort (Signal-grade requires sharing the key 1:1 with
-- each contact). Existing rows get NULL — UI falls back to initials.
ALTER TABLE users ADD COLUMN avatar_b64 TEXT;
ALTER TABLE groups ADD COLUMN avatar_b64 TEXT;

-- Down Migration

ALTER TABLE groups DROP COLUMN avatar_b64;
ALTER TABLE users DROP COLUMN avatar_b64;
