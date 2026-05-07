import { eq, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { messages } from './schema.js';
import type { BufferedMessage, AckResult, MessagesRepo } from './messages.js';
import type { ConversationKind } from '@speakeasy/shared';

export class DrizzleMessagesRepo implements MessagesRepo {
  async insert(
    msg: Omit<BufferedMessage, 'createdAt'> & { createdAt?: Date },
  ): Promise<void> {
    const db = getDb();
    await db.insert(messages).values({
      id: msg.id,
      conversation: msg.conversation,
      senderId: msg.senderId,
      recipientId: msg.recipientId,
      ciphertext: msg.ciphertext,
      msgType: msg.msgType,
      skdmGroupId: msg.skdmGroupId ?? null,
      targetDevices: sql`${JSON.stringify(msg.targetDevices)}::jsonb`,
      deliveredToDevices: sql`${JSON.stringify(msg.deliveredToDevices)}::jsonb`,
      sealed: msg.sealed,
      delivered: false,
      createdAt: msg.createdAt ?? new Date(),
      expiresAt: msg.expiresAt,
    });
  }

  async listUndeliveredFor(
    recipientId: string,
    deviceToken: string,
  ): Promise<BufferedMessage[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(messages)
      .where(
        sql`${messages.recipientId} = ${recipientId} AND (
          ${messages.targetDevices} @> '[]'::jsonb
          OR (
            ${messages.targetDevices}::jsonb ?? ${deviceToken}
            AND NOT (${messages.deliveredToDevices}::jsonb ?? ${deviceToken})
          )
        )`,
      )
      .orderBy(messages.createdAt);

    return rows.map((row) => ({
      id: row.id,
      conversation: row.conversation,
      senderId: row.senderId,
      recipientId: row.recipientId,
      ciphertext: row.ciphertext,
      msgType: row.msgType as ConversationKind,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      skdmGroupId: row.skdmGroupId ?? undefined,
      targetDevices: (row.targetDevices as string[]) ?? [],
      deliveredToDevices: (row.deliveredToDevices as string[]) ?? [],
      sealed: row.sealed ?? false,
    }));
  }

  async markDeliveredByDevice(
    messageId: string,
    deviceToken: string,
  ): Promise<AckResult> {
    const db = getDb();
    return db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(messages)
        .where(eq(messages.id, messageId))
        .for('update');

      const row = rows[0];
      if (!row) return { kind: 'not_found' } as const;

      const targetDevices = (row.targetDevices as string[]) ?? [];
      const deliveredToDevices = (row.deliveredToDevices as string[]) ?? [];

      // Legacy shortcut: no target devices known at insert time — any ack deletes
      if (targetDevices.length === 0) {
        await tx.delete(messages).where(eq(messages.id, messageId));
        return {
          kind: 'fully_delivered',
          senderId: row.senderId,
          recipientId: row.recipientId,
        } as const;
      }

      // Add deviceToken to deliveredToDevices if not already present
      const updated = deliveredToDevices.includes(deviceToken)
        ? deliveredToDevices
        : [...deliveredToDevices, deviceToken];

      // Check if all targetDevices have acked
      const allDelivered = targetDevices.every((d) => updated.includes(d));

      if (allDelivered) {
        await tx.delete(messages).where(eq(messages.id, messageId));
        return {
          kind: 'fully_delivered',
          senderId: row.senderId,
          recipientId: row.recipientId,
        } as const;
      }

      // Still pending — persist the updated deliveredToDevices
      await tx
        .update(messages)
        .set({ deliveredToDevices: sql`${JSON.stringify(updated)}::jsonb` })
        .where(eq(messages.id, messageId));

      return { kind: 'pending' } as const;
    });
  }
}
