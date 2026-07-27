import type {
  DiagUploadRecord,
  DiagUploadsRepo,
  StoredDiagUpload,
} from './diag.js';

export class InMemoryDiagUploadsRepo implements DiagUploadsRepo {
  readonly rows: StoredDiagUpload[] = [];
  private nextId = 1;

  async insert(record: DiagUploadRecord): Promise<void> {
    this.rows.push({
      id: this.nextId++,
      userId: record.userId,
      callId: record.callId ?? null,
      appVersion: record.appVersion,
      reason: record.reason,
      entries: record.entries,
      createdAt: new Date(),
    });
  }

  async listByCallId(callId: string): Promise<StoredDiagUpload[]> {
    return this.rows
      .filter((r) => r.callId === callId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listByUser(userId: string, limit = 50): Promise<StoredDiagUpload[]> {
    return this.rows
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async purgeOlderThan(cutoff: Date): Promise<number> {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      if (this.rows[i]!.createdAt < cutoff) this.rows.splice(i, 1);
    }
    return before - this.rows.length;
  }
}
