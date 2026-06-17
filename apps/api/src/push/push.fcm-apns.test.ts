import { describe, expect, it } from 'vitest';
import {
  buildAndroidPushMessage,
  buildIosPushData,
  resolveBannerCopy,
} from './push.fcm-apns.js';
import type { PushDeliveryNotice } from './push.js';

function notice(overrides: Partial<PushDeliveryNotice> = {}): PushDeliveryNotice {
  return {
    userId: 'bob',
    conversationId: 'direct:alice:bob',
    msgType: 'direct',
    kind: 'message',
    senderId: 'alice',
    messageId: 'msg-1',
    ciphertext: 'abc123',
    ...overrides,
  };
}

describe('buildIosPushData', () => {
  it('forwards ciphertext and sender metadata for rich iOS message pushes', () => {
    expect(buildIosPushData(notice(), 'rich')).toEqual({
      conversation_id: 'direct:alice:bob',
      msg_type: 'direct',
      notify_kind: 'message',
      message_id: 'msg-1',
      sender_id: 'alice',
      ciphertext: 'abc123',
    });
  });

  it('omits ciphertext for private devices', () => {
    expect(buildIosPushData(notice(), 'private')).not.toHaveProperty('ciphertext');
  });

  it('omits ciphertext for sealed messages without sender identity', () => {
    expect(buildIosPushData(notice({ senderId: undefined }), 'rich')).not.toHaveProperty(
      'ciphertext',
    );
  });
});

describe('buildAndroidPushMessage', () => {
  const opts = (privacy: 'rich' | 'private') => ({
    title: '@alice',
    body: 'New message',
    privacy,
    tokens: ['tok-1', 'tok-2'],
  });

  it('rich: data-only (no notification block) and forwards ciphertext', () => {
    const msg = buildAndroidPushMessage(notice(), opts('rich'));
    // Data-only so the headless handler runs to decrypt + render.
    expect(msg.android?.notification).toBeUndefined();
    expect(msg.notification).toBeUndefined();
    expect(msg.android?.priority).toBe('high');
    expect(msg.data?.ciphertext).toBe('abc123');
    expect(msg.data).toMatchObject({
      conversation_id: 'direct:alice:bob',
      msg_type: 'direct',
      sender_id: 'alice',
      title: '@alice',
      body: 'New message',
    });
    expect(msg.tokens).toEqual(['tok-1', 'tok-2']);
  });

  it('private: real notification block on the high-importance channel, no ciphertext', () => {
    const msg = buildAndroidPushMessage(notice(), opts('private'));
    // A notification message so the OS renders it immediately even with
    // the process dead (no headless handler needed).
    expect(msg.android?.notification).toEqual({
      title: '@alice',
      body: 'New message',
      channelId: 'speakeasy_default',
    });
    expect(msg.android?.priority).toBe('high');
    // Private devices opt out of the decrypted preview.
    expect(msg.data).not.toHaveProperty('ciphertext');
    // Data still rides along for tap-routing + the foreground path.
    expect(msg.data?.conversation_id).toBe('direct:alice:bob');
  });
});

describe('resolveBannerCopy', () => {
  it('direct rich: sender handle as title', () => {
    expect(resolveBannerCopy(notice(), 'rich')).toEqual({ title: '@alice', body: 'New message' });
  });

  it('direct private: generic title, no sender leak', () => {
    expect(resolveBannerCopy(notice(), 'private')).toEqual({
      title: 'speakeasy',
      body: 'New message',
    });
  });

  it('group rich: room name as title instead of @sender', () => {
    const n = notice({ msgType: 'group', groupName: 'Poker Night', conversationId: 'group:xyz' });
    expect(resolveBannerCopy(n, 'rich')).toEqual({ title: 'Poker Night', body: 'New message' });
  });

  it('group private: generic title, room name withheld', () => {
    const n = notice({ msgType: 'group', groupName: 'Poker Night' });
    expect(resolveBannerCopy(n, 'private').title).toBe('speakeasy');
  });

  it('group rich without a name (unnamed room): generic title', () => {
    const n = notice({ msgType: 'group', groupName: undefined });
    expect(resolveBannerCopy(n, 'rich').title).toBe('speakeasy');
  });

  it('call rich: ringer copy', () => {
    const n = notice({ kind: 'call' });
    expect(resolveBannerCopy(n, 'rich')).toEqual({ title: '@alice', body: 'Calling…' });
  });
});
