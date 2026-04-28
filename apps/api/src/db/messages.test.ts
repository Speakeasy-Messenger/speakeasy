import { describe, expect, it } from 'vitest';
import { InMemoryMessagesRepo } from './messages.memory.js';

function buf(s: string): Buffer {
  return Buffer.from(s);
}

const sevenDays = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

interface InsertOpts {
  id: string;
  recipientId?: string;
  senderId?: string;
  conversation?: string;
  body?: string;
  createdAt?: Date;
  targetDevices?: string[];
  deliveredToDevices?: string[];
}
function newRowDefaults(o: InsertOpts) {
  return {
    id: o.id,
    conversation: o.conversation ?? 'dm-aaa',
    senderId: o.senderId ?? 'alice',
    recipientId: o.recipientId ?? 'bob',
    ciphertext: buf(o.body ?? o.id),
    msgType: 'direct' as const,
    createdAt: o.createdAt,
    expiresAt: sevenDays(),
    targetDevices: o.targetDevices ?? [],
    deliveredToDevices: o.deliveredToDevices ?? [],
  };
}

describe('InMemoryMessagesRepo', () => {
  it('insert + listUndeliveredFor returns rows for the recipient, oldest first', async () => {
    const r = new InMemoryMessagesRepo();
    await r.insert(newRowDefaults({ id: 'm2', createdAt: new Date(2026, 3, 25, 12, 0, 1) }));
    await r.insert(newRowDefaults({ id: 'm1', createdAt: new Date(2026, 3, 25, 12, 0, 0) }));
    await r.insert(
      newRowDefaults({ id: 'm3', recipientId: 'carol', conversation: 'dm-bbb', createdAt: new Date(2026, 3, 25, 12, 0, 2) }),
    );

    // Empty targetDevices = legacy single-device shortcut: any drain returns it.
    const forBob = await r.listUndeliveredFor('bob', 'any-device-token');
    expect(forBob.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(await r.listUndeliveredFor('carol', 'any')).toHaveLength(1);
    expect(await r.listUndeliveredFor('dave', 'any')).toHaveLength(0);
  });

  it('legacy single-device path: any single ack deletes the row', async () => {
    const r = new InMemoryMessagesRepo();
    await r.insert(newRowDefaults({ id: 'm1', senderId: 'a', recipientId: 'b' }));

    const result = await r.markDeliveredByDevice('m1', 'first-device');
    expect(result).toEqual({ kind: 'fully_delivered', senderId: 'a', recipientId: 'b' });
    expect((await r.markDeliveredByDevice('m1', 'second-device'))).toEqual({ kind: 'not_found' });
    expect(await r.listUndeliveredFor('b', 'any')).toHaveLength(0);
  });

  it('multi-device: pending until every targetDevice has acked', async () => {
    const r = new InMemoryMessagesRepo();
    await r.insert(
      newRowDefaults({
        id: 'm1',
        senderId: 'a',
        recipientId: 'b',
        targetDevices: ['dvtA', 'dvtB', 'dvtC'],
      }),
    );

    expect(await r.markDeliveredByDevice('m1', 'dvtA')).toEqual({ kind: 'pending' });
    expect(await r.markDeliveredByDevice('m1', 'dvtB')).toEqual({ kind: 'pending' });
    // Re-acking from a device we already saw is idempotent + still pending.
    expect(await r.markDeliveredByDevice('m1', 'dvtA')).toEqual({ kind: 'pending' });
    // Final device ack → row deletes + delivered fires.
    expect(await r.markDeliveredByDevice('m1', 'dvtC')).toEqual({
      kind: 'fully_delivered',
      senderId: 'a',
      recipientId: 'b',
    });
    expect(await r.listUndeliveredFor('b', 'dvtA')).toHaveLength(0);
  });

  it('listUndeliveredFor filters by deviceToken so a re-connecting device does not redrain', async () => {
    const r = new InMemoryMessagesRepo();
    await r.insert(
      newRowDefaults({
        id: 'm1',
        recipientId: 'b',
        targetDevices: ['dvtA', 'dvtB'],
      }),
    );

    // dvtA acks (still pending — dvtB hasn't).
    await r.markDeliveredByDevice('m1', 'dvtA');

    // dvtA reconnects: should NOT redrain (it already acked).
    expect(await r.listUndeliveredFor('b', 'dvtA')).toHaveLength(0);
    // dvtB hasn't acked yet → still drainable from B's reconnect.
    expect(await r.listUndeliveredFor('b', 'dvtB')).toHaveLength(1);
    // A device not in targetDevices (e.g. a brand-new device that paired in
    // after the message was sent) should NOT receive the buffered message.
    expect(await r.listUndeliveredFor('b', 'dvtNEW')).toHaveLength(0);
  });

  it('not_found for an unknown messageId', async () => {
    const r = new InMemoryMessagesRepo();
    expect(await r.markDeliveredByDevice('does-not-exist', 'anything')).toEqual({
      kind: 'not_found',
    });
  });
});
