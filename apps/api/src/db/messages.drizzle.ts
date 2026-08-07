import { eq, lte, sql } from 'drizzle-orm';
import { getDb } from './client.js';
import { messageDeliveryTombstones, messages } from './schema.js';
import type {
  AckResult,
  BufferedMessage,
  MessageInsertResult,
  MessagesRepo,
} from './messages.js';
import type { ConversationKind } from '@speakeasy/shared';

export class DrizzleMessagesRepo implements MessagesRepo {
  async insert(
    msg: Omit<BufferedMessage, 'createdAt'> & { createdAt?: Date },
  ): Promise<MessageInsertResult> {
    const db = getDb();
    return db.transaction(async (tx) => {
      // The dedupe marker contains no message metadata or ciphertext. Purge
      // it after the relay TTL before reserving the next client id.
      const now = new Date();
      // Payload first: the migration's DELETE trigger marks its tombstone
      // delivered, then the second delete removes that expired marker too.
      await tx.delete(messages).where(lte(messages.expiresAt, now));
      await tx
        .delete(messageDeliveryTombstones)
        .where(lte(messageDeliveryTombstones.expiresAt, now));

      const reserved = await tx
        .insert(messageDeliveryTombstones)
        .values({
          messageId: msg.id,
          expiresAt: msg.expiresAt,
          delivered: false,
        })
        .onConflictDoNothing({ target: messageDeliveryTombstones.messageId })
        .returning({ messageId: messageDeliveryTombstones.messageId });

      if (reserved.length === 0) {
        const existing = await tx
          .select({ delivered: messageDeliveryTombstones.delivered })
          .from(messageDeliveryTombstones)
          .where(eq(messageDeliveryTombstones.messageId, msg.id))
          .limit(1);
        return existing[0]?.delivered
          ? 'duplicate_delivered'
          : 'duplicate_pending';
      }

      // Phase-one rolling compatibility mirrors old writers at the database
      // boundary. Phase two may reject legacy duplicate inserts, so mark this
      // transaction as the owner of the reservation before inserting its
      // payload. The setting is transaction-local and parameterized.
      await tx.execute(
        sql`SELECT set_config('speakeasy.message_reservation_id', ${msg.id}, true)`,
      );

      const payloadInserted = await tx
        .insert(messages)
        .values({
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
        })
        // Defensive fallback for any pre-trigger legacy payload anomaly.
        .onConflictDoNothing({ target: messages.id })
        .returning({ id: messages.id });
      return payloadInserted.length > 0 ? 'inserted' : 'duplicate_pending';
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
        sql`${messages.expiresAt} > NOW()
          AND ${messages.recipientId} = ${recipientId} AND (
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

  async getById(messageId: string): Promise<BufferedMessage | null> {
    const db = getDb();
    const rows = await db.select().from(messages).where(eq(messages.id, messageId));
    const row = rows[0];
    if (!row) return null;
    return {
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
    };
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

      // Legacy shortcut: no target devices known at insert time — any ack
      // deletes the payload row and marks its metadata-free id reservation.
      if (targetDevices.length === 0) {
        await tx.delete(messages).where(eq(messages.id, messageId));
        await tx
          .insert(messageDeliveryTombstones)
          .values({
            messageId,
            expiresAt: row.expiresAt,
            delivered: true,
          })
          .onConflictDoUpdate({
            target: messageDeliveryTombstones.messageId,
            set: { delivered: true, expiresAt: row.expiresAt },
          });
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
        await tx
          .insert(messageDeliveryTombstones)
          .values({
            messageId,
            expiresAt: row.expiresAt,
            delivered: true,
          })
          .onConflictDoUpdate({
            target: messageDeliveryTombstones.messageId,
            set: { delivered: true, expiresAt: row.expiresAt },
          });
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
