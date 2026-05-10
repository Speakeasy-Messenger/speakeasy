-- Up Migration
--
-- Capture user-submitted feedback. The `@feedback` handle is reserved
-- on the API server so users can't claim it; messages addressed to
-- @feedback in the mobile client take a separate (non-E2E) path —
-- POST /v1/feedback, plaintext, Vouchflow-authed — and land here.
-- This is opt-in by the user: the chat UI should make clear that
-- messages here aren't end-to-end encrypted (they go to the dev team).

CREATE TABLE IF NOT EXISTS feedback (
  -- Client-generated fb-XXX id (using `newFeedbackId()` from shared);
  -- mirrors the existing message-id pattern so we don't pull in a
  -- BIGSERIAL when the rest of the schema is text-keyed.
  id              TEXT PRIMARY KEY,
  sender_user_id  TEXT NOT NULL,
  -- App version at the time of report — populated client-side from
  -- AboutScreen's VERSION constant. Helps triage ("does this still
  -- repro on rc.40?") without having to ask.
  app_version     TEXT,
  -- Free-form body. Same 800-byte cap the message envelope uses
  -- elsewhere (see `messages.text_max_chars`) so a confused paste
  -- can't blow up the row size.
  text            TEXT NOT NULL CHECK (length(text) > 0 AND length(text) <= 4000),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set when the dev-side feedback dump script reviews the row, so
  -- subsequent dumps can default to "show only unreviewed".
  reviewed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS feedback_unreviewed_idx
  ON feedback (created_at)
  WHERE reviewed_at IS NULL;

-- Down Migration

DROP INDEX IF EXISTS feedback_unreviewed_idx;
DROP TABLE IF EXISTS feedback;
