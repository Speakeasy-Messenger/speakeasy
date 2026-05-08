-- Phase 2 brand overhaul (AVATAR-SYSTEM.md §8): replace JPEG-blob
-- profile photos with animal-id avatar selections, and drop group
-- photos entirely (groups now use deterministic geometric room marks).

-- Users: add the new column. Drop the old one.
ALTER TABLE users ADD COLUMN selected_avatar_id TEXT;
ALTER TABLE users DROP COLUMN avatar_b64;

-- Groups: drop the photo column outright. The room mark is rendered
-- client-side from a hash of the group id.
ALTER TABLE groups DROP COLUMN avatar_b64;
