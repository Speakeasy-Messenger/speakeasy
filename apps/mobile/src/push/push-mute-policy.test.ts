import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistPushMuteSnapshot,
  shouldSuppressPushForMute,
} from './push-mute-policy.js';
import {
  clearPendingInboundMessages,
  drainPendingInboundMessages,
  enqueuePendingInboundMessage,
} from './pending-inbound.js';
import type { ChatMessage } from '../store/conversations.js';

const message = (id: string): ChatMessage => ({
  id,
  from: 'bananaman7',
  text: 'fast background message',
  attachments: [
    {
      kind: 'file',
      mime: 'text/plain',
      data: 'aGVsbG8=',
      name: 'hello.txt',
    },
  ],
  mentions: ['tututu'],
  kind: 'direct',
  sentAt: 1_000,
  stage: 'sent',
});

describe('shouldSuppressPushForMute', () => {
  beforeEach(async () => {
    await persistPushMuteSnapshot({});
    await clearPendingInboundMessages();
  });

  it('suppresses only ids in the lightweight encrypted mute snapshot', async () => {
    await persistPushMuteSnapshot({
      c1: { muted: true },
      c2: { muted: false },
    });

    await expect(shouldSuppressPushForMute('c1')).resolves.toBe(true);
    await expect(shouldSuppressPushForMute('c2')).resolves.toBe(false);
    await expect(shouldSuppressPushForMute('missing')).resolves.toBe(false);
  });

  it('durably drains a background message once and preserves its payload', async () => {
    const add = vi.fn();
    const persist = vi.fn(async () => {});
    const pending = { conversationId: 'dm-abc', message: message('m1') };

    await enqueuePendingInboundMessage(pending);
    await enqueuePendingInboundMessage(pending);

    await expect(drainPendingInboundMessages({ add, persist })).resolves.toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith('dm-abc', pending.message);
    expect(persist).toHaveBeenCalledTimes(1);

    await expect(drainPendingInboundMessages({ add, persist })).resolves.toBe(0);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('keeps the encrypted inbox when the conversation persist fails', async () => {
    const add = vi.fn();
    await enqueuePendingInboundMessage({
      conversationId: 'grp-xyz',
      message: { ...message('m2'), kind: 'group' },
    });

    await expect(
      drainPendingInboundMessages({
        add,
        persist: async () => {
          throw new Error('disk unavailable');
        },
      }),
    ).rejects.toThrow('disk unavailable');

    const persist = vi.fn(async () => {});
    await expect(drainPendingInboundMessages({ add, persist })).resolves.toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});
