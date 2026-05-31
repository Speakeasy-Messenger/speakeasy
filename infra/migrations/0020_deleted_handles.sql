-- Up Migration
--
-- Tombstone table for handles that were deleted via `DELETE /v1/users/me`.
--
-- Why this exists: when @alice deletes her account, @bob (who has an
-- active conversation with her) has no way to know she's gone. His
-- client keeps the chat open, his messages either fail silently or
-- accumulate in the relay buffer for nobody to drain. This table is
-- the server-side anchor for the peer-deleted notification flow:
--
--   - REST `GET /v1/users/:handle` returns 410 Gone for handles in
--     this table (distinct from 404 = never existed).
--   - REST `POST /v1/prekeys/bundle` returns 410 too — stops the
--     fetcher from establishing a new Signal session against a
--     ghost identity.
--   - WS `message` frames targeting a handle in this table get
--     refused: server emits `peer_deleted` to the sender instead of
--     buffering, and the recipient row is never written.
--
-- The handle is stored as the primary key — same string the user
-- claimed at enrollment. No PII; the row is just the fact that "@x
-- deleted, here's when."
--
-- Reclaim policy (Phase 2): an enrollment cooldown will reject
-- attempts to claim a handle in this table for N days after
-- `deleted_at`. Not enforced in this migration. Until then, the
-- application layer can race: A deletes @alice, Eve claims @alice
-- before any of A's peers checks. The Signal cryptographic identity
-- (public key) protects existing session continuity — Eve has new
-- keys, B's existing session refuses to silently rotate — but the
-- "fresh chat" path with the new @alice would not be flagged. Phase 2
-- closes that gap.

CREATE TABLE IF NOT EXISTS deleted_handles (
  handle      TEXT PRIMARY KEY,
  deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on deleted_at for the Phase 2 cooldown lookup. Cheap to add
-- now and avoids a future ALTER TABLE on a hot path.
CREATE INDEX IF NOT EXISTS deleted_handles_deleted_at_idx
  ON deleted_handles (deleted_at);

-- Down Migration
-- DROP INDEX IF EXISTS deleted_handles_deleted_at_idx;
-- DROP TABLE IF EXISTS deleted_handles;
