import { describe, expect, it } from 'vitest';
import {
  consumeForegroundTap,
  createForegroundTapDrain,
  directPeerForPush,
  notificationTapData,
  parsePersistedPush,
  toPersistedPush,
} from './push-tap-target.js';

describe('push tap targets', () => {
  it('routes a generic first-contact direct push from its sender id', () => {
    const displayedData = notificationTapData({
      conversation_id: 'dm-first-contact',
      notify_kind: 'message',
      msg_type: 'direct',
      sender_id: 'new-peer',
    });

    expect(displayedData).toEqual({
      conversation_id: 'dm-first-contact',
      notify_kind: 'message',
      msg_type: 'direct',
      sender_id: 'new-peer',
    });

    const queued = toPersistedPush(displayedData, 123_456);
    const push = parsePersistedPush(JSON.parse(JSON.stringify(queued)));
    expect(push).not.toBeNull();
    expect(directPeerForPush(push!, undefined)).toBe('new-peer');
  });

  it('prefers the hydrated conversation peer over push metadata', () => {
    const push = toPersistedPush({
      conversation_id: 'dm-existing',
      notify_kind: 'message',
      msg_type: 'direct',
      sender_id: 'push-sender',
    });

    expect(directPeerForPush(push!, 'stored-peer')).toBe('stored-peer');
  });

  it('does not invent a peer when neither source identifies one', () => {
    const push = toPersistedPush({
      conversation_id: 'dm-sealed',
      notify_kind: 'message',
      msg_type: 'direct',
    });

    expect(directPeerForPush(push!, undefined)).toBeUndefined();
  });

  it('recovers a native tap stashed just after AppState becomes active', async () => {
    const push = toPersistedPush({
      conversation_id: 'dm-late-native-intent',
      notify_kind: 'message',
      msg_type: 'direct',
      sender_id: 'zzz',
    })!;
    let nativeReads = 0;
    const waited: number[] = [];

    const result = await consumeForegroundTap({
      consumeNative: async () => {
        nativeReads += 1;
        return nativeReads === 2 ? push : null;
      },
      consumeDeferred: async () => null,
      wait: async (ms) => {
        waited.push(ms);
      },
    });

    expect(result).toEqual({
      source: 'native',
      value: push,
      nativeAttempt: 2,
    });
    expect(waited).toEqual([100]);
  });

  it('routes a native tap immediately when the intent is already stashed', async () => {
    const push = toPersistedPush({
      conversation_id: 'dm-ready-native-intent',
      notify_kind: 'message',
      msg_type: 'direct',
      sender_id: 'zzz',
    })!;
    const waited: number[] = [];

    const result = await consumeForegroundTap({
      consumeNative: async () => push,
      consumeDeferred: async () => null,
      wait: async (ms) => {
        waited.push(ms);
      },
    });

    expect(result).toEqual({
      source: 'native',
      value: push,
      nativeAttempt: 1,
    });
    expect(waited).toEqual([]);
  });

  it('keeps the deferred notifee tap path immediate', async () => {
    const push = toPersistedPush({
      conversation_id: 'dm-deferred',
      notify_kind: 'message',
      msg_type: 'direct',
      sender_id: 'peer',
    })!;
    const waited: number[] = [];

    const result = await consumeForegroundTap({
      consumeNative: async () => null,
      consumeDeferred: async () => push,
      wait: async (ms) => {
        waited.push(ms);
      },
    });

    expect(result).toEqual({
      source: 'deferred',
      value: push,
      nativeAttempt: 1,
    });
    expect(waited).toEqual([]);
  });

  it('returns null after the native retry window expires', async () => {
    const waited: number[] = [];

    const result = await consumeForegroundTap({
      consumeNative: async () => null,
      consumeDeferred: async () => null,
      wait: async (ms) => {
        waited.push(ms);
      },
    });

    expect(result).toBeNull();
    expect(waited).toEqual([100, 400]);
  });

  it('coalesces overlapping foreground drains through routing', async () => {
    let releaseConsume!: (push: ReturnType<typeof toPersistedPush>) => void;
    const consume = new Promise<ReturnType<typeof toPersistedPush>>((resolve) => {
      releaseConsume = resolve;
    });
    const routed: string[] = [];
    let consumeCalls = 0;
    const drain = createForegroundTapDrain({
      consume: async () => {
        consumeCalls += 1;
        return consume;
      },
      handle: async (push) => {
        routed.push(push!.conversationId);
      },
    });

    const first = drain();
    const second = drain();
    releaseConsume(
      toPersistedPush({
        conversation_id: 'dm-overlapping-active-events',
        notify_kind: 'message',
        msg_type: 'direct',
        sender_id: 'zzz',
      }),
    );
    await Promise.all([first, second]);

    expect(consumeCalls).toBe(1);
    expect(routed).toEqual(['dm-overlapping-active-events']);
  });
});
