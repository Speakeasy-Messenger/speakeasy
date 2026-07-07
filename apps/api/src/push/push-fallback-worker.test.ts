import { describe, expect, it, vi } from 'vitest';
import { InMemoryMessagesRepo } from '../db/messages.memory.js';
import type { BufferedMessage } from '../db/messages.js';
import { createPushFallbackQueue } from './push-fallback-queue.js';
import { startPushFallbackWorker } from './push-fallback-worker.js';
import type { PushDeliveryNotice, PushProvider } from './push.js';

function makeMsg(overrides: Partial<BufferedMessage> = {}): BufferedMessage {
  return {
    id: 'm1',
    conversation: 'direct:alice:bob',
    senderId: 'alice',
    recipientId: 'bob',
    ciphertext: Buffer.from('ct'),
    msgType: 'direct',
    createdAt: new Date(0),
    expiresAt: new Date(60_000),
    targetDevices: ['dev-1'],
    deliveredToDevices: [],
    sealed: false,
    ...overrides,
  };
}

function collectorPush(): { push: PushProvider; sent: PushDeliveryNotice[] } {
  const sent: PushDeliveryNotice[] = [];
  return {
    sent,
    push: {
      async notifyDelivery(n) {
        sent.push(n);
      },
    },
  };
}

describe('push fallback worker', () => {
  it('fires a forced generic banner for a message still buffered after the delay', async () => {
    const messages = new InMemoryMessagesRepo();
    await messages.insert(makeMsg());
    const queue = createPushFallbackQueue();
    queue.enqueue('m1', 1000);
    const { push, sent } = collectorPush();

    const stop = startPushFallbackWorker({
      queue,
      messages,
      push,
      intervalMs: 5,
      now: () => 2000, // past the m1 deadline
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    stop();

    expect(sent[0]).toMatchObject({
      userId: 'bob',
      conversationId: 'direct:alice:bob',
      senderId: 'alice',
      messageId: 'm1',
      forceBanner: true,
    });
    // No ciphertext on the fallback (the app is presumed dead).
    expect(sent[0]!.ciphertext).toBeUndefined();
  });

  it('sends NOTHING for a message that was already delivered (row gone)', async () => {
    const messages = new InMemoryMessagesRepo(); // never inserted → getById → null
    const queue = createPushFallbackQueue();
    queue.enqueue('delivered-msg', 1000);
    const { push, sent } = collectorPush();

    const stop = startPushFallbackWorker({
      queue,
      messages,
      push,
      intervalMs: 5,
      now: () => 2000,
    });
    // Let several ticks run — the claim happens, getById returns null, no push.
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(sent).toHaveLength(0);
  });

  it('hides the sender on the fallback for a sealed message', async () => {
    const messages = new InMemoryMessagesRepo();
    await messages.insert(makeMsg({ id: 'm2', sealed: true }));
    const queue = createPushFallbackQueue();
    queue.enqueue('m2', 1000);
    const { push, sent } = collectorPush();

    const stop = startPushFallbackWorker({
      queue,
      messages,
      push,
      intervalMs: 5,
      now: () => 2000,
    });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    stop();
    expect(sent[0]!.senderId).toBeUndefined();
    expect(sent[0]!.messageId).toBe('m2');
  });
});
