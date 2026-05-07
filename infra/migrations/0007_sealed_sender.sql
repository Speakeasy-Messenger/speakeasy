-- Up Migration

-- Sealed sender (spec §13 / §11 Phase 5g). Direct messages can opt
-- into hiding the sender's identity from the recipient's wire frame
-- and from the server-side `audit: 'message_send'` log.
--
-- Server still stores `sender_id` because the AckRouter needs it to
-- route `delivered` events back to the original sender; full
-- envelope-style sealing (where the server doesn't know who sent
-- either) is a v2 effort and would require encrypting the
-- routing-id with a server-issued certificate.
--
-- Existing rows default to FALSE (= unsealed legacy behaviour).
ALTER TABLE messages
  ADD COLUMN sealed BOOLEAN NOT NULL DEFAULT FALSE;
