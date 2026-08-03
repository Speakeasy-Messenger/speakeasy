export type PushTapData = {
  conversation_id?: string;
  notify_kind?: 'message' | 'call';
  msg_type?: 'direct' | 'group';
  sender_id?: string;
};

/**
 * Minimal durable form of a notification tap.
 *
 * `senderId` is authoritative for a first-contact direct message: no
 * conversation row exists yet, so the foreground store cannot recover the
 * peer from `conversationId` until WebSocket replay lands the message.
 */
export type PersistedPush = {
  conversationId: string;
  kind: 'message' | 'call';
  msgType: 'direct' | 'group' | undefined;
  senderId: string | undefined;
  persistedAt: number;
};

/** Keep every field required to route a notification after it is tapped. */
export function notificationTapData(data: PushTapData): Record<string, string> {
  return {
    conversation_id: data.conversation_id ?? '',
    notify_kind: data.notify_kind ?? 'message',
    ...(data.msg_type ? { msg_type: data.msg_type } : {}),
    ...(data.sender_id ? { sender_id: data.sender_id } : {}),
  };
}

/** Convert FCM/notifee/native tap data into its durable foreground form. */
export function toPersistedPush(
  data: PushTapData,
  persistedAt = Date.now(),
): PersistedPush | null {
  if (!data.conversation_id || !data.notify_kind) return null;
  return {
    conversationId: data.conversation_id,
    kind: data.notify_kind,
    msgType: data.msg_type,
    senderId: data.sender_id,
    persistedAt,
  };
}

/** Restore a queued background tap without discarding first-contact identity. */
export function parsePersistedPush(value: unknown): PersistedPush | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<PersistedPush>;
  if (
    !parsed.conversationId ||
    (parsed.kind !== 'message' && parsed.kind !== 'call')
  ) {
    return null;
  }
  return {
    conversationId: parsed.conversationId,
    kind: parsed.kind,
    msgType: parsed.msgType,
    senderId: parsed.senderId,
    persistedAt:
      typeof parsed.persistedAt === 'number' ? parsed.persistedAt : Date.now(),
  };
}

/**
 * Prefer the hydrated conversation identity, but fall back to the sender
 * carried by the push while a first-contact message is still replaying.
 */
export function directPeerForPush(
  push: PersistedPush,
  storedPeerId: string | undefined,
): string | undefined {
  return storedPeerId ?? push.senderId;
}
