import { describe, expect, it } from 'vitest';
import { buildIosPushData } from './push.fcm-apns.js';
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
