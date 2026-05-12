-- Up Migration
--
-- Third schema-vs-migration drift in this same `messages` table —
-- a triplet of bugs that all hide inside `listUndeliveredFor` and
-- collectively kept the WS auth handshake silently failing through
-- multiple alpha builds. Earlier 0010 + 0011 fixed the missing
-- `users.device_token` and `messages.recipient_id`; this one fixes
-- the column TYPE mismatch.
--
-- `apps/api/src/db/schema.ts` declares both `target_devices` and
-- `delivered_to_devices` as `jsonb('...').$type<string[]>().default([])`,
-- and the rc.12+ `listUndeliveredFor` query relies on `jsonb_array_length`
-- and the `?` JSONB existence operator — neither of which exists for
-- `text[]`. The DB has them as `text[]` instead because the original
-- `0001_initial.sql`'s `CREATE TABLE messages` plus the per-device
-- columns added in `0005_per_device_delivery.sql` (added them as
-- TEXT[], not JSONB).
--
-- Symptom: every WS auth handshake throws `42883: function
-- jsonb_array_length(text[]) does not exist` inside `deliverBuffered`,
-- the handler catches it as `auth_failed`, and the client cycles.
--
-- The `messages` table is empty (the prior bugs prevented anyone
-- from authenticating successfully + sending), so conversion is
-- trivial. Use `to_jsonb(...)` for safety in case rows exist in
-- other environments.

-- Drop the existing text[] defaults first — Postgres can't auto-cast
-- a `'{}'::text[]` default to jsonb during the type change. Set a
-- fresh `'[]'::jsonb` default afterward in the same statement.
ALTER TABLE messages
  ALTER COLUMN target_devices DROP DEFAULT,
  ALTER COLUMN target_devices TYPE jsonb USING to_jsonb(target_devices),
  ALTER COLUMN target_devices SET DEFAULT '[]'::jsonb;

ALTER TABLE messages
  ALTER COLUMN delivered_to_devices DROP DEFAULT,
  ALTER COLUMN delivered_to_devices TYPE jsonb USING to_jsonb(delivered_to_devices),
  ALTER COLUMN delivered_to_devices SET DEFAULT '[]'::jsonb;

-- Down Migration

ALTER TABLE messages
  ALTER COLUMN target_devices TYPE text[] USING (
    SELECT array_agg(value::text)
      FROM jsonb_array_elements_text(target_devices) AS value
  ),
  ALTER COLUMN target_devices SET DEFAULT '{}';

ALTER TABLE messages
  ALTER COLUMN delivered_to_devices TYPE text[] USING (
    SELECT array_agg(value::text)
      FROM jsonb_array_elements_text(delivered_to_devices) AS value
  ),
  ALTER COLUMN delivered_to_devices SET DEFAULT '{}';
