-- Up Migration
--
-- Phase 2 (April 2026): channel-key distribution model clarified — see spec §4b.
--
-- The original communities.encrypted_key column held a single blob and was
-- underspecified for distribution. The real model wraps the AES-256 channel
-- key K once per recipient (with that recipient's identity public key) and
-- stores the resulting envelopes here. Server holds envelopes only;
-- never plaintext K. Existing members are responsible for wrapping K for
-- new members and POSTing the envelope.

CREATE TABLE community_key_envelopes (
  community_id        TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  recipient_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  /** Channel key K wrapped for `recipient_user_id`'s public key (ECIES). */
  wrapped_key         BYTEA NOT NULL,
  /** Member who performed the wrap (for audit + revocation). */
  wrapped_by_user_id  TEXT NOT NULL REFERENCES users(id),
  /** Monotonically increasing per (community_id, recipient_user_id). Bumps on rotation. */
  key_epoch           INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, recipient_user_id, key_epoch)
);

CREATE INDEX community_key_envelopes_recipient_idx
  ON community_key_envelopes(recipient_user_id);

-- The single-blob column on communities is no longer the source of truth.
ALTER TABLE communities DROP COLUMN encrypted_key;

-- Down Migration

ALTER TABLE communities ADD COLUMN encrypted_key BYTEA NOT NULL DEFAULT '\x00';
DROP INDEX IF EXISTS community_key_envelopes_recipient_idx;
DROP TABLE IF EXISTS community_key_envelopes;
