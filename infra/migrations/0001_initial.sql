-- Up Migration

CREATE TABLE users (
  id          TEXT PRIMARY KEY,
  public_key  BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE prekey_bundles (
  user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  registration_id    INTEGER NOT NULL,
  signed_prekey_id   INTEGER NOT NULL,
  signed_prekey      BYTEA NOT NULL,
  signed_prekey_sig  BYTEA NOT NULL,
  prekeys            JSONB NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE groups (
  id          TEXT PRIMARY KEY,
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX group_members_user_idx ON group_members(user_id);

CREATE TABLE communities (
  id             TEXT PRIMARY KEY,
  created_by     TEXT NOT NULL REFERENCES users(id),
  encrypted_key  BYTEA NOT NULL,
  ttl_days       INTEGER NOT NULL DEFAULT 7,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (ttl_days > 0)
);

CREATE TABLE community_members (
  community_id  TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role          TEXT NOT NULL DEFAULT 'member',
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (community_id, user_id),
  CHECK (role IN ('member', 'moderator'))
);

CREATE INDEX community_members_user_idx ON community_members(user_id);

-- Message relay buffer (all conversation types).
-- Rows are deleted on confirmed delivery; otherwise expire after 7 days.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  conversation  TEXT NOT NULL,
  sender_id     TEXT NOT NULL REFERENCES users(id),
  ciphertext    BYTEA NOT NULL,
  msg_type      TEXT NOT NULL,
  delivered     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  CHECK (msg_type IN ('direct', 'group', 'community'))
);

CREATE INDEX messages_conversation_idx ON messages(conversation, created_at);
CREATE INDEX messages_expires_idx ON messages(expires_at) WHERE delivered = FALSE;

-- Down Migration

DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS community_members;
DROP TABLE IF EXISTS communities;
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
DROP TABLE IF EXISTS prekey_bundles;
DROP TABLE IF EXISTS users;
