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
  | { type: 'skdm'; to: string; group_id: string; ciphertext: string };

export type WsServerMsg =
  | { type: 'authed'; user_id: UserId }
  | {
      type: 'message';
      from: UserId;
      ciphertext: string;
      message_id: MessageId;
      msg_type: ConversationKind;
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
  | { type: 'prekeys_low'; remaining_prekeys: number };

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
