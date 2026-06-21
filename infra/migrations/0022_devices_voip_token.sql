-- iOS PushKit (VoIP) token for CallKit incoming-call wake-ups. Separate from
-- push_token (FCM/APNs banner): VoIP pushes go direct-APNs to <bundleId>.voip
-- with apns-push-type: voip. Nullable — only iOS devices that registered a
-- PushKit token have one; Android and pre-CallKit clients leave it NULL.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS voip_token text;
