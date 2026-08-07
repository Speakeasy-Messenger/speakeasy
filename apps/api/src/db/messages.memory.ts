import type {
  AckResult,
  BufferedMessage,
  MessageInsertResult,
  MessagesRepo,
} from './messages.js';

export class InMemoryMessagesRepo implements MessagesRepo {
  readonly buffer = new Map<string, BufferedMessage>();
  readonly tombstones = new Map<
    string,
    { expiresAt: Date; delivered: boolean }
  >();

  async insert(
    msg: Omit<BufferedMessage, 'createdAt'> & { createdAt?: Date },
  ): Promise<MessageInsertResult> {
    // Match the drizzle impl's onConflictDoNothing({ target: messages.id }):
    // ids are client-supplied (direct) or derived from a client-supplied id
    // (group/community fan-out), and a retransmitted frame must be a no-op —
    // NOT an overwrite, which would reset a partially-acked row's
    // deliveredToDevices.
    const now = Date.now();
    for (const [id, row] of this.buffer) {
      if (row.expiresAt.getTime() <= now) this.buffer.delete(id);
    }
    for (const [id, tombstone] of this.tombstones) {
      if (tombstone.expiresAt.getTime() <= now) this.tombstones.delete(id);
    }
    const existing = this.tombstones.get(msg.id);
    if (existing) {
      return existing.delivered
        ? 'duplicate_delivered'
        : 'duplicate_pending';
    }
    const row: BufferedMessage = {
      ...msg,
      createdAt: msg.createdAt ?? new Date(),
      // Defensive copies so caller mutations don't affect stored state.
      targetDevices: [...msg.targetDevices],
      deliveredToDevices: [...msg.deliveredToDevices],
    };
    this.tombstones.set(row.id, {
      expiresAt: row.expiresAt,
      delivered: false,
    });
    this.buffer.set(row.id, row);
    return 'inserted';
  }

  async listUndeliveredFor(
    recipientId: string,
    deviceToken: string,
  ): Promise<BufferedMessage[]> {
    const out: BufferedMessage[] = [];
    for (const m of this.buffer.values()) {
      if (m.expiresAt.getTime() <= Date.now()) continue;
      if (m.recipientId !== recipientId) continue;
      if (m.targetDevices.length === 0) {
        // Legacy / no-device-known-at-insert: any device drains.
        out.push(m);
        continue;
      }
      if (!m.targetDevices.includes(deviceToken)) continue;
      if (m.deliveredToDevices.includes(deviceToken)) continue;
      out.push(m);
    }
    out.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return out;
  }

  async getById(messageId: string): Promise<BufferedMessage | null> {
    return this.buffer.get(messageId) ?? null;
  }

  async markDeliveredByDevice(
    messageId: string,
    deviceToken: string,
  ): Promise<AckResult> {
    const row = this.buffer.get(messageId);
    if (!row) return { kind: 'not_found' };

    // Legacy path: any single ack removes the relay payload but retains the
    // id until its normal expiry, so a sender replay after a lost `delivered`
    // receipt cannot recreate and redeliver the message.
    if (row.targetDevices.length === 0) {
      this.buffer.delete(messageId);
      this.tombstones.set(messageId, {
        expiresAt: row.expiresAt,
        delivered: true,
      });
      return { kind: 'fully_delivered', senderId: row.senderId, recipientId: row.recipientId };
    }

    // Idempotent: re-acking from the same device is a no-op (don't
    // double-count), but still treat as delivered if everyone is done.
    if (!row.deliveredToDevices.includes(deviceToken)) {
      row.deliveredToDevices = [...row.deliveredToDevices, deviceToken];
    }

    const allAcked = row.targetDevices.every((d) =>
      row.deliveredToDevices.includes(d),
    );
    if (!allAcked) {
      return { kind: 'pending' };
    }
    this.buffer.delete(messageId);
    this.tombstones.set(messageId, {
      expiresAt: row.expiresAt,
      delivered: true,
    });
    return { kind: 'fully_delivered', senderId: row.senderId, recipientId: row.recipientId };
  }
}
