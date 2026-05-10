-- Up Migration
--
-- Add `groups.name` so the room's display name propagates from creator
-- to invitees. Pre-rc.48 the name was a client-only string captured
-- in NewGroupScreen and persisted in mobile's `useGroups` store; the
-- server stored only id + creator + member set. New members thus saw
-- the raw `grp-…` id in the AppBar and `[group not loaded]` errors
-- when sending (mobile bailed because `useGroups.byId[gid]` was
-- undefined).
--
-- Nullable on purpose: existing rows pre-migration have no name and
-- that's fine — the mobile client falls back to a default
-- ("Room with @x, @y") for unnamed groups so old conversations
-- aren't broken by the schema change.

ALTER TABLE groups ADD COLUMN IF NOT EXISTS name TEXT;

-- Down Migration

ALTER TABLE groups DROP COLUMN IF EXISTS name;
