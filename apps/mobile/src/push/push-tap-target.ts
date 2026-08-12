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

export type ForegroundTap<T> = {
  source: 'native' | 'deferred';
  value: T;
  nativeAttempt: number;
};

/**
 * Coalesce repeated AppState `active` notifications into one tap drain.
 * Consuming the native slot is destructive, so overlapping drains must share
 * both the consume and handle phases or one callback can steal the tap from
 * the callback that would have routed it.
 */
export function createForegroundTapDrain<T>(args: {
  consume: () => Promise<T | null>;
  handle: (value: T) => Promise<void>;
}): () => Promise<void> {
  let activeDrain: Promise<void> | null = null;

  return () => {
    if (activeDrain) return activeDrain;
    activeDrain = (async () => {
      const value = await args.consume();
      if (value) await args.handle(value);
    })().finally(() => {
      activeDrain = null;
    });
    return activeDrain;
  };
}

/**
 * Drain a tap when Android returns the app to the foreground.
 *
 * MainActivity and React Native do not guarantee that `onNewIntent` has
 * populated the native tap slot before JS observes AppState `active`. Check
 * the slot immediately, preserve the legacy deferred/notifee path, then poll
 * the native slot briefly so a late intent cannot strand the tap until the
 * next foreground transition.
 */
export async function consumeForegroundTap<T>(args: {
  consumeNative: () => Promise<T | null>;
  consumeDeferred: () => Promise<T | null>;
  wait?: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
}): Promise<ForegroundTap<T> | null> {
  const wait =
    args.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const retryDelays = args.retryDelaysMs ?? [100, 400];

  const immediateNative = await args.consumeNative();
  if (immediateNative) {
    return { source: 'native', value: immediateNative, nativeAttempt: 1 };
  }

  const deferred = await args.consumeDeferred();
  if (deferred) {
    return { source: 'deferred', value: deferred, nativeAttempt: 1 };
  }

  for (let i = 0; i < retryDelays.length; i += 1) {
    await wait(retryDelays[i]!);
    const native = await args.consumeNative();
    if (native) {
      return { source: 'native', value: native, nativeAttempt: i + 2 };
    }
  }

  return null;
}

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
