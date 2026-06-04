-- #13 unified call entry: per-user "Refuse video calls" setting.
-- When true, the call-router rejects inbound video offers before ringing
-- this user, and the /v1/users/:id capability aggregation drops 'video'
-- from supported_call_kinds. Default false (video accepted).
ALTER TABLE users ADD COLUMN refuse_video boolean NOT NULL DEFAULT false;
