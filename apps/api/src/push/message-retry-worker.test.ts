import { describe, expect, it, vi } from 'vitest';
import { startMessageRetryWorker, RETRY_MAX_AGE_MS } from './message-retry-worker.js';
import { RETRY_DELAY_MS } from './message-retry-queue.js';
import type { BufferedMessage } from '../db/messages.js';

function row(over: Partial<BufferedMessage> = {}): BufferedMessage {
  return {
    id: 'm1',
    conversation: 'grp-1',
    senderId: 'alice',
    recipientId: 'bob',
    ciphertext: Buffer.from('cipher'),
    msgType: 'group',
    createdAt: new Date(1_000_000),
    targetDevices: [],
    deliveredToDevices: [],
    sealed: false,
    ...over,
  };
}

function harness(opts: {
  now: number;
  getById: (id: string) => Promise<BufferedMessage | null>;
}) {
  const claimed = ['m1'];
  const queue = {
    enqueue: vi.fn(),
    claimDue: vi.fn(async () => claimed.splice(0, claimed.length)),
  };
  const notifyDelivery = vi.fn(async () => {});
  const messages = { getById: vi.fn(opts.getById) } as never;
  const stop = startMessageRetryWorker({
    queue: queue as never,
    messages,
    push: { notifyDelivery } as never,
    groupName: async () => 'Homeless shelter',
    intervalMs: 5,
    now: () => opts.now,
  });
  return { queue, notifyDelivery, messages, stop };
}

const tick = () => new Promise((r) => setTimeout(r, 15));

describe('message retry worker', () => {
  it('re-sends the ORIGINAL push (ciphertext + group name) for an unacked row', async () => {
    const h = harness({ now: 1_010_000, getById: async () => row() });
    await tick();
    h.stop();
    expect(h.notifyDelivery).toHaveBeenCalledTimes(1);
    const notice = h.notifyDelivery.mock.calls[0][0];
    expect(notice.ciphertext).toBe(Buffer.from('cipher').toString('base64'));
    expect(notice.groupName).toBe('Homeless shelter');
    expect(notice.senderId).toBe('alice');
    // never a stripped banner: it always carries the payload
    expect(notice.messageId).toBe('m1');
  });

  it('re-enqueues the next retry while still within the age window', async () => {
    const now = 1_010_000;
    const h = harness({ now, getById: async () => row() });
    await tick();
    h.stop();
    expect(h.queue.enqueue).toHaveBeenCalledWith('m1', now + RETRY_DELAY_MS);
  });

  it('does NOTHING when the row is gone (already acked over WS or HTTP)', async () => {
    const h = harness({ now: 1_010_000, getById: async () => null });
    await tick();
    h.stop();
    expect(h.notifyDelivery).not.toHaveBeenCalled();
    expect(h.queue.enqueue).not.toHaveBeenCalled();
  });

  it('gives up (no resend, no re-enqueue) once the message exceeds the max age', async () => {
    const created = 1_000_000;
    const h = harness({
      now: created + RETRY_MAX_AGE_MS + 1,
      getById: async () => row({ createdAt: new Date(created) }),
    });
    await tick();
    h.stop();
    expect(h.notifyDelivery).not.toHaveBeenCalled();
    expect(h.queue.enqueue).not.toHaveBeenCalled();
  });

  it('omits the sender for a sealed message', async () => {
    const h = harness({ now: 1_010_000, getById: async () => row({ sealed: true }) });
    await tick();
    h.stop();
    expect(h.notifyDelivery.mock.calls[0][0].senderId).toBeUndefined();
  });
});
