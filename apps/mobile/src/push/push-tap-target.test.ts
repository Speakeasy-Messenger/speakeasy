import { describe, expect, it } from 'vitest';
import {
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
});
