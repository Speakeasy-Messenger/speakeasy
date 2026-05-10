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
        // Two bugs lived in the prior version of this query:
        //
        // 1. `??` was used hoping for the JDBC-style escape that some
        //    drivers translate to a literal `?`. node-postgres (8.20.0)
        //    does NOT perform that translation; PostgreSQL received
        //    `??` and threw `42883: operator does not exist: jsonb ?? text`
        //    on every call, throwing inside `deliverBuffered` and
        //    cascading into the rapid WS auth-then-close cycle the
        //    rc.8 user reported.
        //
        // 2. `target_devices @> '[]'::jsonb` was meant as the
        //    "legacy: no targets specified at insert time → any device
        //    drains" shortcut. But `@> '[]'` is a tautology for jsonb
        //    arrays (every set contains the empty set), so the OR
        //    short-circuited to true and the predicate degraded to
        //    just `recipient_id = $1` — every device would have
        //    drained every undelivered message. Replaced with
        //    `jsonb_array_length(...) = 0` to match the memory impl's
        //    `m.targetDevices.length === 0` semantics.
        //
        // The repo's vitest tests use the in-memory impl, so neither
        // bug surfaced in CI. Mirror the in-memory behavior here as
        // the contract.
        sql`${messages.recipientId} = ${recipientId} AND (
          jsonb_array_length(${messages.targetDevices}) = 0
          OR (
            ${messages.targetDevices}::jsonb ? ${deviceToken}
            AND NOT (${messages.deliveredToDevices}::jsonb ? ${deviceToken})
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
