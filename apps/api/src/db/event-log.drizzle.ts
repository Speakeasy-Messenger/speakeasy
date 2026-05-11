import { and, desc, eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { serverEventLog } from './schema.js';
import type { EventLogRecord, EventLogRepo, RecordedEvent } from './event-log.js';

export class DrizzleEventLogRepo implements EventLogRepo {
  async record(entry: EventLogRecord): Promise<void> {
    const db = getDb();
    await db.insert(serverEventLog).values({
      eventType: entry.eventType,
      userId: entry.userId ?? null,
      payload: entry.payload ?? {},
    });
  }

  async recentForUser(userId: string, limit = 50): Promise<RecordedEvent[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(serverEventLog)
      .where(and(eq(serverEventLog.userId, userId)))
      .orderBy(desc(serverEventLog.ts))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      eventType: r.eventType,
      userId: r.userId,
      payload: (r.payload as Record<string, unknown>) ?? {},
    }));
  }
}
