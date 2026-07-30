import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistPushMuteSnapshot,
  shouldSuppressPushForMute,
} from './push-mute-policy.js';
import {
  clearPendingInboundMessages,
  drainPendingInboundMessages,
  enqueuePendingInboundMessage,
  pendingInboundFromDecryptedPush,
} from './pending-inbound.js';
import type { ChatMessage } from '../store/conversations.js';
import { useConversations } from '../store/conversations.js';
import { newMessageId } from '@speakeasy/shared';

const { secureStore, failConversationWrites } = vi.hoisted(() => ({
  secureStore: new Map<string, string>(),
  failConversationWrites: { current: false },
}));

vi.mock('../native/secure-kv.js', () => ({
  secureKv: {
    get: vi.fn(async (key: string) => secureStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      if (
        failConversationWrites.current &&
        key === 'speakeasy.conversations.v1'
      ) {
        throw new Error('disk unavailable');
      }
      secureStore.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      secureStore.delete(key);
    }),
  },
}));

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
    secureStore.clear();
    failConversationWrites.current = false;
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

  it('derives the mute snapshot from encrypted history on first push after upgrade', async () => {
    secureStore.delete('speakeasy.push-mutes.v1');
    secureStore.set(
      'speakeasy.conversations.v1',
      JSON.stringify({
        mutedBeforeUpgrade: { muted: true, messages: [] },
        audibleBeforeUpgrade: { muted: false, messages: [] },
      }),
    );

    await expect(
      shouldSuppressPushForMute('mutedBeforeUpgrade'),
    ).resolves.toBe(true);
    await expect(
      shouldSuppressPushForMute('audibleBeforeUpgrade'),
    ).resolves.toBe(false);
    expect(JSON.parse(secureStore.get('speakeasy.push-mutes.v1')!)).toEqual([
      'mutedBeforeUpgrade',
    ]);
  });

  it('removes stale mute suppression when a conversation is deleted', async () => {
    await useConversations.getState().reset();
    useConversations.getState().setMuted('dm-removed', true);
    await expect(shouldSuppressPushForMute('dm-removed')).resolves.toBe(true);

    useConversations.getState().removeConversation('dm-removed');

    await expect(shouldSuppressPushForMute('dm-removed')).resolves.toBe(false);
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

  it('converts direct and group decrypted payloads without losing attachments', () => {
    const messageId = newMessageId();
    const payload = {
      v: 1 as const,
      text: 'caption',
      attachments: message('template').attachments,
      mentions: ['tututu'],
    };

    const direct = pendingInboundFromDecryptedPush({
      conversationId: 'dm-abc',
      messageId,
      senderId: 'bananaman7',
      msgType: 'direct',
      payload,
    });
    expect(direct.message).toMatchObject({
      id: messageId,
      from: 'bananaman7',
      text: 'caption',
      attachments: payload.attachments,
      mentions: ['tututu'],
      kind: 'direct',
    });
    expect(direct.message.receivedAt).toEqual(expect.any(Number));

    const group = pendingInboundFromDecryptedPush({
      conversationId: 'grp-xyz',
      messageId,
      senderId: 'bananaman7',
      msgType: 'group',
      payload,
    });
    expect(group.conversationId).toBe('grp-xyz');
    expect(group.message.kind).toBe('group');
  });

  it('prefers the server relay timestamp over sender clock metadata', () => {
    const messageId = newMessageId();
    const pending = pendingInboundFromDecryptedPush({
      conversationId: 'dm-abc',
      messageId,
      senderId: 'bananaman7',
      msgType: 'direct',
      payload: { v: 1, text: 'ordered by server' },
      sentAt: 123_456,
      receivedAt: 123_999,
    });

    expect(pending.message.sentAt).toBe(123_456);
    expect(pending.message.receivedAt).toBe(123_999);
  });

  it('serializes concurrent enqueues without dropping distinct messages', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        enqueuePendingInboundMessage({
          conversationId: 'dm-abc',
          message: message(`concurrent-${index}`),
        }),
      ),
    );

    const add = vi.fn();
    await expect(
      drainPendingInboundMessages({ add, persist: async () => {} }),
    ).resolves.toBe(20);
    expect(new Set(add.mock.calls.map((call) => call[1].id)).size).toBe(20);
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

  it('keeps the inbox across process-death hydration when the real store write fails', async () => {
    await useConversations.getState().reset();
    await useConversations.getState().hydrate();
    await enqueuePendingInboundMessage({
      conversationId: 'dm-abc',
      message: message('process-death'),
    });

    failConversationWrites.current = true;
    await useConversations.getState().hydrate();
    expect(secureStore.get('speakeasy.pending-inbound.v1')).toContain(
      'process-death',
    );

    // Simulate the next process launch: disk still has no conversation copy,
    // but the inbox survived and replays once persistence is healthy.
    useConversations.setState({ byId: {}, hydrated: false });
    failConversationWrites.current = false;
    await useConversations.getState().hydrate();
    expect(
      useConversations
        .getState()
        .byId['dm-abc']?.messages.filter((item) => item.id === 'process-death'),
    ).toHaveLength(1);
    expect(secureStore.has('speakeasy.pending-inbound.v1')).toBe(false);
  });
});
