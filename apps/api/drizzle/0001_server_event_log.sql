-- Persistent server-side event log (rc.57). See
-- infra/migrations/0015_server_event_log.sql for full rationale.
--
-- The drizzle baseline (0000) diverged from prod long ago because
-- infra/migrations/0010–0014 were hand-applied via psql, never
-- through drizzle-kit. A vanilla `drizzle-kit generate` here produces
-- a migration that tries to re-add columns/indexes that already exist
-- in prod and fails on deploy. So we surgically hand-write this one
-- to ONLY introduce the new table + indexes. The drizzle baseline
-- staying stale is fine — schema.ts is the source of truth for the
-- code path; this folder is just the migration applier.

CREATE TABLE IF NOT EXISTS "server_event_log" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "ts" timestamp with time zone DEFAULT now() NOT NULL,
  "event_type" text NOT NULL,
  "user_id" text,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS "server_event_log_user_ts"
  ON "server_event_log" USING btree ("user_id","ts");

CREATE INDEX IF NOT EXISTS "server_event_log_type_ts"
  ON "server_event_log" USING btree ("event_type","ts");
