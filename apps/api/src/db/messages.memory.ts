import type { AckResult, BufferedMessage, MessagesRepo } from './messages.js';

export class InMemoryMessagesRepo implements MessagesRepo {
  readonly buffer = new Map<string, BufferedMessage>();

  async insert(
    msg: Omit<BufferedMessage, 'createdAt'> & { createdAt?: Date },
  ): Promise<void> {
    const row: BufferedMessage = {
      ...msg,
      createdAt: msg.createdAt ?? new Date(),
      // Defensive copies so caller mutations don't affect stored state.
      targetDevices: [...msg.targetDevices],
      deliveredToDevices: [...msg.deliveredToDevices],
    };
    this.buffer.set(row.id, row);
  }

  async listUndeliveredFor(
    recipientId: string,
    deviceToken: string,
  ): Promise<BufferedMessage[]> {
    const out: BufferedMessage[] = [];
    for (const m of this.buffer.values()) {
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

  async markDeliveredByDevice(
    messageId: string,
    deviceToken: string,
  ): Promise<AckResult> {
    const row = this.buffer.get(messageId);
    if (!row) return { kind: 'not_found' };

    // Legacy path: any single ack deletes (matches pre-Phase-5f shape
    // for first-time recipients with no devices known at insert time).
    if (row.targetDevices.length === 0) {
      this.buffer.delete(messageId);
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
    return { kind: 'fully_delivered', senderId: row.senderId, recipientId: row.recipientId };
  }
}
