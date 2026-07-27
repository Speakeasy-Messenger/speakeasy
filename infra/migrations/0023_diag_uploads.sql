-- Up Migration
--
-- Beta-only diagnostic log uploads. The mobile Diagnostics screen has
-- always been copy-paste-only ("open Diagnostics, paste the log back to
-- me") — and half the time the ring buffer had already rolled or the
-- process had restarted before the tester got to it. This table is the
-- durable sink for the SAME already-redacted buffer, streamed
-- automatically on abnormal call ends + crashes (and on a manual button).
--
-- Metadata only. The uploaded `entries` are the client diag buffer, which
-- is redacted at write time (handles + message previews are one-way
-- fingerprints; no plaintext content — see apps/mobile/src/diag/log.ts).
-- The `POST /v1/diag` route additionally strips every entry down to the
-- known DiagEntry keys (t, tag, msg, ctx) as defense-in-depth.
--
-- Beta only. The route 403s any appVersion without "-rc.", so GA clients
-- can never write here even if they call the endpoint.
--
-- `call_id` is nullable (crash/manual uploads have no call) and indexed so
-- both sides of a failed call — which upload independently — can be pulled
-- together by call_id.
--
-- Retention: diag payloads are debugging exhaust, not durable data. Purge
-- rows older than 14 days via `DiagUploadsRepo.purgeOlderThan()`. There is
-- no periodic job runner in this service yet, so the purge query is
-- exposed on the repo and called from wherever a sweeper eventually lands;
-- until then run it ad hoc (psql via `flyctl postgres connect`). Volume is
-- bounded — beta cohort only, a handful of rows per failed call.

CREATE TABLE diag_uploads (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT NOT NULL,
  -- Nullable: crash / manual uploads are not tied to a call.
  call_id     TEXT,
  app_version TEXT NOT NULL,
  reason      TEXT NOT NULL,
  -- Redacted DiagEntry[] — see header. JSONB so we can query by tag later.
  entries     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Correlate both sides of the same call. Partial: most rows (crash/manual)
-- have no call_id and shouldn't bloat the index.
CREATE INDEX diag_uploads_call_id_idx ON diag_uploads(call_id) WHERE call_id IS NOT NULL;
-- "Everything this tester uploaded recently", newest first.
CREATE INDEX diag_uploads_user_created_idx ON diag_uploads(user_id, created_at DESC);

-- Down Migration

DROP INDEX IF EXISTS diag_uploads_user_created_idx;
DROP INDEX IF EXISTS diag_uploads_call_id_idx;
DROP TABLE IF EXISTS diag_uploads;
