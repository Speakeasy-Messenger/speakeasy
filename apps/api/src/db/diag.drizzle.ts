import { and, desc, eq, lt } from 'drizzle-orm';
import { getDb } from './client.js';
import { diagUploads } from './schema.js';
import type {
  DiagEntry,
  DiagUploadRecord,
  DiagUploadsRepo,
  StoredDiagUpload,
} from './diag.js';

export class DrizzleDiagUploadsRepo implements DiagUploadsRepo {
  async insert(record: DiagUploadRecord): Promise<void> {
    const db = getDb();
    await db.insert(diagUploads).values({
      userId: record.userId,
      callId: record.callId ?? null,
      appVersion: record.appVersion,
      reason: record.reason,
      entries: record.entries,
    });
  }

  async listByCallId(callId: string): Promise<StoredDiagUpload[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(diagUploads)
      .where(eq(diagUploads.callId, callId))
      .orderBy(desc(diagUploads.createdAt));
    return rows.map(mapRow);
  }

  async listByUser(userId: string, limit = 50): Promise<StoredDiagUpload[]> {
    const db = getDb();
    const rows = await db
      .select()
      .from(diagUploads)
      .where(and(eq(diagUploads.userId, userId)))
      .orderBy(desc(diagUploads.createdAt))
      .limit(limit);
    return rows.map(mapRow);
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const db = getDb();
    const deleted = await db
      .delete(diagUploads)
      .where(lt(diagUploads.createdAt, cutoff))
      .returning({ id: diagUploads.id });
    return deleted.length;
  }
}

function mapRow(r: typeof diagUploads.$inferSelect): StoredDiagUpload {
  return {
    id: r.id,
    userId: r.userId,
    callId: r.callId,
    appVersion: r.appVersion,
    reason: r.reason,
    entries: (r.entries as DiagEntry[]) ?? [],
    createdAt: r.createdAt,
  };
}
