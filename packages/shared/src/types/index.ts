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
  | { type: 'auth'; token: string }
  | { type: 'message'; to: string; ciphertext: string; msg_type: ConversationKind }
  | { type: 'ack'; message_id: MessageId }
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
  | { type: 'call_offer'; to: UserId; call_id: CallId; ciphertext: string }
  | { type: 'call_answer'; to: UserId; call_id: CallId; ciphertext: string }
  | { type: 'call_ice'; to: UserId; call_id: CallId; ciphertext: string }
  | { type: 'call_end'; to: UserId; call_id: CallId; reason: CallEndReason };

export type WsServerMsg =
  | { type: 'authed'; user_id: UserId }
  | {
      type: 'message';
      from: UserId;
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
       */
      conversation_id: string;
    }
  | { type: 'delivered'; message_id: MessageId }
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
  | { type: 'call_offer'; from: UserId; call_id: CallId; ciphertext: string }
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
  | 'busy'; // callee already in a call

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
