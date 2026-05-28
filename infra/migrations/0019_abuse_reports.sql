-- Up Migration
--
-- Per-(reporter, reported) abuse reports. Backs the Report action on
-- the conversation settings screen (mobile) and the auto-ban-on-5-reports
-- moderation rule on the server.
--
-- Behavioral notes:
--
--   - UNIQUE (reporter_user_id, reported_user_id) is the dedup
--     guarantee: a single user cannot file 5 reports against the
--     same target and trigger an instant ban. Filling the threshold
--     requires 5 distinct reporters.
--
--   - reporter_user_id has ON DELETE CASCADE so when a user deletes
--     their own account, their pending reports disappear with them.
--     This is the right behavior: we shouldn't keep accusations from
--     accounts that no longer exist.
--
--   - reported_user_id has NO foreign key. Once the auto-ban
--     deletes the reported user, the report rows survive as an audit
--     trail. Moderation review needs to see the reports that
--     triggered the ban after the fact.
--
--   - reason is constrained to a known set; new reasons need a
--     migration to extend the CHECK. The mobile picker mirrors this
--     set via @speakeasy/shared.
--
--   - The 90-day decay window is enforced in application code, not
--     here. Old reports stay in the table for audit but the threshold
--     check filters by created_at.

CREATE TABLE IF NOT EXISTS abuse_reports (
  id                  BIGSERIAL PRIMARY KEY,
  reporter_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_user_id    TEXT NOT NULL,
  reason              TEXT NOT NULL CHECK (
                        reason IN ('spam', 'harassment', 'threats', 'hate_speech', 'other')
                      ),
  -- Free-form 200-char detail. Only meaningful when reason = 'other'
  -- but allowed on any reason so users can add context if they want.
  detail              TEXT CHECK (detail IS NULL OR length(detail) <= 200),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Dedup: one report per pair, ever. A second report from the same
  -- reporter against the same target is rejected at insert time (the
  -- route catches the unique violation and returns 200 idempotent —
  -- the client doesn't need to know it was already filed).
  UNIQUE (reporter_user_id, reported_user_id)
);

-- Threshold check query path: WHERE reported_user_id = $1
--   AND created_at > NOW() - INTERVAL '90 days'. The index covers
-- both clauses for the auto-ban hot path.
CREATE INDEX IF NOT EXISTS abuse_reports_reported_recent_idx
  ON abuse_reports (reported_user_id, created_at);

-- Down Migration
-- DROP INDEX IF EXISTS abuse_reports_reported_recent_idx;
-- DROP TABLE IF EXISTS abuse_reports;
