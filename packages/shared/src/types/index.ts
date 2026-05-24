export type UserId = string;
export type GroupId = string;
export type CommunityId = string;
export type MessageId = string;
export type ConversationId = string;

export type ConversationKind = 'direct' | 'group' | 'community';

export type CommunityRole = 'member' | 'moderator';

export interface User {
  id: UserId;
  publicKey: Uint8Array;
  createdAt: Date;
}

export interface PreKeyBundle {
  userId: UserId;
  registrationId: number;
  signedPreKeyId: number;
  signedPreKey: Uint8Array;
  signedPreKeySig: Uint8Array;
  preKeys: Array<{ id: number; key: Uint8Array }>;
  updatedAt: Date;
}

export interface Group {
  id: GroupId;
  createdBy: UserId;
  createdAt: Date;
}

export interface GroupMember {
  groupId: GroupId;
  userId: UserId;
  joinedAt: Date;
}

export interface Community {
  id: CommunityId;
  createdBy: UserId;
  encryptedKey: Uint8Array;
  ttlDays: number;
  createdAt: Date;
}

export interface CommunityMember {
  communityId: CommunityId;
  userId: UserId;
  role: CommunityRole;
  joinedAt: Date;
}

export interface Message {
  id: MessageId;
  conversation: ConversationId;
  senderId: UserId;
  ciphertext: Uint8Array;
  msgType: ConversationKind;
  delivered: boolean;
  createdAt: Date;
  expiresAt: Date;
}

// ------------ WebSocket envelope schemas (spec §9) ------------

export type WsClientMsg =
  /**
   * `supported_call_kinds` lets a sender's mobile preflight which call
   * modes a peer can actually answer (see `/v1/users/:id` aggregation).
   * Older clients omit the field; server treats absence as
   * `['audio', 'video']` for back-compat. Private-Call-capable clients
   * send `['audio', 'video', 'private']`.
   */
  | { type: 'auth'; token: string; supported_call_kinds?: CallKind[] }
  | {
      type: 'message';
      to: string;
      ciphertext: string;
      msg_type: ConversationKind;
      /**
       * Sealed-sender flag (spec §13). When true on a `direct`
       * message, the server suppresses the `from` field on the
       * forwarded frame + on the buffer-drain replay, and elides
       * the sender id from its `audit: 'message_send'` log line.
       *
       * The `ciphertext` contents are the sender's responsibility:
       * they should wrap (sender_id, signal_ciphertext) using
       * ECIES against the recipient's identity public key, so the
       * recipient can recover the sender id without the server
       * leaking it. The server is opaque to the inner format.
       *
       * Server ignores the flag for `group` / `community` messages
       * (sealing fan-out has no obvious meaning + would require
       * more invasive design).
       */
      sealed?: boolean;
      /**
       * Client-generated message id. The sender stamps its optimistic
       * bubble with this id; for `direct` messages the server adopts
       * it as the row id, so the `delivered` / `read` frames routed
       * back to the sender carry an id the sender's bubble actually
       * has — without it, receipts can never attach. Optional: if a
       * client omits it the server generates one (older clients still
       * work, just without working receipts). Ignored for
       * group/community (server assigns per-recipient ids).
       */
      message_id?: MessageId;
    }
  | { type: 'ack'; message_id: MessageId }
  /**
   * Read receipt — recipient signals to the original sender that
   * `message_id` has been visibly opened (chat scrolled into view).
   * Server forwards as a `read` server frame to `to`. 1:1 only for
   * now (group reads would leak room activity beyond what spec §13
   * commits to). Plaintext on the wire — the message_id is already
   * known to both parties; the timing is the only new bit, and that
   * leaks the same information the existing `delivered` frame does.
   */
  | { type: 'read'; to: UserId; message_id: MessageId }
  | { type: 'ping' }
  /**
   * Sender Key Distribution Message — bootstrap envelope for group
   * messaging. The `ciphertext` is an SKDM byte-payload encrypted via
   * the sender's 1:1 Signal session with `to`. `group_id` carries the
   * group context the recipient needs to attribute the SenderKey to
   * the right conversation when calling
   * `groupMessaging.processSenderKeyDistribution`.
   *
   * Server treats this exactly like a `direct` message at the relay
   * level (one row per recipient, persist-and-forward, ack-delete) but
   * dispatches as a separate frame type to the recipient.
   */
  | { type: 'skdm'; to: string; group_id: string; ciphertext: string }
  // ----- Voice call signaling (1:1 only — see Call* types below) -----
  /**
   * `kind` is a plaintext hint (the encrypted SDP carries the same value)
   * so the server can fan-out the offer ONLY to the peer's devices that
   * advertised the required capability in their WS auth. Without this
   * hint the server would have to fan out everywhere; the receiver-side
   * `KNOWN_CALL_KINDS` guard catches that case as defense in depth, but
   * the brand cost is real (an old device rings, then drops). Absent
   * `kind` ⇒ treat as `'audio'` for back-compat (pre-rc.34 clients).
   */
  | {
      type: 'call_offer';
      to: UserId;
      call_id: CallId;
      ciphertext: string;
      kind?: CallKind;
    }
  | { type: 'call_answer'; to: UserId; call_id: CallId; ciphertext: string }
  | { type: 'call_ice'; to: UserId; call_id: CallId; ciphertext: string }
  | { type: 'call_end'; to: UserId; call_id: CallId; reason: CallEndReason };

export type WsServerMsg =
  | { type: 'authed'; user_id: UserId }
  | {
      type: 'message';
      /**
       * Sender of the message. Omitted on sealed-sender direct
       * messages — the inner ciphertext carries the sender's
       * identity instead, wrapped against the recipient's identity
       * key. Recipients should treat absence as "this is sealed,
       * unwrap to recover sender" rather than as an error.
       *
       * Always present on `group` / `community` messages.
       */
      from?: UserId;
      ciphertext: string;
      message_id: MessageId;
      msg_type: ConversationKind;
      /**
       * Server-computed conversation id. For `direct` it's the
       * sha256-derived `dm-…` id; for `group`/`community` it's the
       * group/community id directly. Lets the recipient bucket the
       * incoming frame into the right local conversation without
       * having to re-derive (and without leaking the group id from
       * inside the ciphertext envelope).
       *
       * For sealed-sender direct messages, this is computed as
       * `conversationIdForDirect(senderId, recipientId)` server-side
       * — it leaks the SET of conversations the recipient is in
       * (same as before), just not which one a given received
       * frame came from. Acceptable: the recipient's own client
       * already knows its conversations.
       */
      conversation_id: string;
    }
  | { type: 'delivered'; message_id: MessageId }
  /**
   * Counterpart to the `read` client frame. The recipient (`from`)
   * has opened the chat and `message_id` is now visibly read. Only
   * fires for 1:1 messages.
   */
  | { type: 'read'; from: UserId; message_id: MessageId }
  | { type: 'pong' }
  | { type: 'error'; code: string; message: string }
  /**
   * Inbound SKDM — counterpart to the client-side `skdm` frame. The
   * recipient's mobile decrypts `ciphertext` via its 1:1 Signal session
   * with `from`, then calls `groupMessaging.processSenderKeyDistribution`
   * to install the SenderKey. Acks via the regular `ack` frame so the
   * server can delete the buffered row.
   */
  | {
      type: 'skdm';
      from: UserId;
      group_id: string;
      ciphertext: string;
      message_id: MessageId;
    }
  /**
   * Server-pushed signal: this user's one-time-prekey pool is below
   * threshold. The mobile client should mint + upload a fresh batch via
   * `POST /v1/prekeys/replenish`. Emitted by `/v1/prekeys/bundle` when a
   * peer's bundle fetch drains the owner's pool.
   */
  | { type: 'prekeys_low'; remaining_prekeys: number }
  /**
   * Server-pushed signal: a community's channel key MUST rotate.
   * Fires on every remaining member's live socket when a member is
   * removed (revocation guarantee per spec §4b) — possibly other
   * triggers in the future (moderator-initiated forced rotation,
   * scheduled rotation, etc.).
   *
   * Mobile-side handling: an existing member (deterministically
   * chosen — moderator with lowest userId is a reasonable rule)
   * generates a fresh K with `key_epoch + 1`, wraps it for every
   * remaining member's identity public key, and uploads the new
   * envelopes via `POST /v1/communities/:id/envelopes`. Server
   * already accepts envelopes with arbitrary `key_epoch`; the
   * `getLatestEnvelope` route returns the highest-epoch envelope
   * so non-uploading members pick up the new key on their next
   * fetch automatically.
   */
  | {
      type: 'channel_key_rotation_required';
      community_id: CommunityId;
      reason: 'member_removed' | 'moderator_triggered';
    }
  // ----- Voice call signaling (1:1 only) -----
  /** Counterpart to client `call_offer` — plaintext `kind` rides on the
   * wire so the receiver's CallScreen can branch BEFORE the ciphertext
   * decrypt finishes (lets the inbound ring screen pick the right
   * eyebrow + state copy without an extra render). Absent ⇒ 'audio'. */
  | {
      type: 'call_offer';
      from: UserId;
      call_id: CallId;
      ciphertext: string;
      kind?: CallKind;
    }
  | { type: 'call_answer'; from: UserId; call_id: CallId; ciphertext: string }
  | { type: 'call_ice'; from: UserId; call_id: CallId; ciphertext: string }
  | { type: 'call_end'; from: UserId; call_id: CallId; reason: CallEndReason };

// ------------ Voice calling (1:1, E2E via DTLS-SRTP authenticated by Signal) ------------

export type CallId = string;

/**
 * Wire-level reason a call ended. Locally the orchestrator may also
 * record synthetic reasons that are never sent over the wire
 * (`no_answer`, `callee_offline`, `error`); see `apps/mobile/src/calls/`.
 */
export type CallEndReason =
  | 'hangup' // active call ended by either party
  | 'decline' // callee rejected the offer
  | 'cancel' // caller cancelled before callee answered
  | 'busy' // callee already in a call
  /**
   * Private Call — the LOCAL filter failed (init failure, model load
   * crash, sustained latency breach, mid-call runtime kill). Sent from
   * the side whose filter died. The brand promise is preserved by
   * failure-closed: no silent fall-back to plain audio.
   */
  | 'filter_failure'
  /**
   * Private Call — the PEER's filter died. The remote end shows
   * "Private Call ended due to a technical issue on the other end",
   * distinct from a social `decline`. Closes Codex tension #5.
   */
  | 'peer_filter_failure';

/**
 * Call modality. `'private'` is the brand-promise mode that filters the
 * sender's voice and drives the peer's animated animal avatar instead of
 * a camera feed. See `lunchbox-main-design-20260524-014323.md`.
 *
 * Unknown values MUST be rejected at the receiver (`KNOWN_KINDS`); the
 * pre-rc.34 silent-coerce-to-audio path was a brand-promise hole — a
 * malicious or stale-client sender could pass `'private'` and the receiver
 * would happily ring with raw audio.
 */
export type CallKind = 'audio' | 'video' | 'private';

/** Runtime guard set. Receivers reject offers whose kind isn't in here. */
export const KNOWN_CALL_KINDS = new Set<CallKind>(['audio', 'video', 'private']);

/**
 * Plaintext shape of the JSON inside `call_offer.ciphertext`. Encrypted
 * via the existing Signal 1:1 session before going on the wire — server
 * cannot read it. The DTLS fingerprint is what authenticates the WebRTC
 * media layer back to the Signal-authenticated identity, blocking any
 * MITM at the TURN relay.
 */
export interface CallOfferPayload {
  v: 1;
  /** SDP offer, RFC 8866 plaintext. */
  sdp: string;
  /** Initial trickle-ICE candidates known at offer time (may be []). */
  candidates: CallIceCandidate[];
  /**
   * Media kind. Older clients (rc.34 and earlier) won't set this; absent
   * is interpreted as 'audio' for backwards compat — voice-only is the
   * historical default and never set this field. Newer clients (rc.130+)
   * MAY set 'private'; the receiver rejects anything not in
   * `KNOWN_CALL_KINDS`.
   */
  kind?: CallKind;
}

export interface CallAnswerPayload {
  v: 1;
  sdp: string;
  candidates: CallIceCandidate[];
}

export interface CallIcePayload {
  v: 1;
  candidates: CallIceCandidate[];
}

export interface CallIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

// ------------ Disappearing-message TTL options (spec §13 suggested) ------------

export const TTL_OPTIONS = {
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
  off: null,
} as const;

export type TtlOption = keyof typeof TTL_OPTIONS;

export const DEFAULT_TTL_SECONDS = TTL_OPTIONS.week;
