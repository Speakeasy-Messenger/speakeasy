-- Up Migration
--
-- Seed the @speaker broadcast bot as a user row. The server fans
-- release announcements out from @speaker; messages.sender_id has a
-- foreign key to users.id, so @speaker must exist as a row. The bot
-- never logs in — public_key / device_token are placeholders and are
-- never used (clients render @speaker messages as plaintext, with no
-- Signal session).

INSERT INTO users (id, public_key, device_token)
VALUES ('speaker', '\x00'::bytea, 'speaker-bot')
ON CONFLICT (id) DO NOTHING;

-- Down Migration
-- DELETE FROM users WHERE id = 'speaker';
