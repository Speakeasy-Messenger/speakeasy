-- Up Migration
-- Phase 5b carry-over: Sender Key Distribution Message (SKDM) wire format.
-- SKDMs are ordinary messages addressed to a single recipient (the encrypted
-- payload is wrapped in a 1:1 Signal session) but carry an extra group_id
-- so the recipient knows which group the SenderKey belongs to. They share
-- the messages table's persist-and-forward + ack-delete lifecycle.
--
-- skdm_group_id is NULL for ordinary direct/group/community messages.

ALTER TABLE messages
  ADD COLUMN skdm_group_id TEXT NULL;

-- Down Migration
-- ALTER TABLE messages DROP COLUMN skdm_group_id;
