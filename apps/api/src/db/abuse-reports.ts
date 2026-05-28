import { and, eq, gt, sql } from 'drizzle-orm';
import type { AbuseReportReason } from '@speakeasy/shared';
import { ABUSE_REPORT_DECAY_DAYS } from '@speakeasy/shared';
import { getDb } from './client.js';
import { abuseReports } from './schema.js';

type Db = ReturnType<typeof getDb>;

/**
 * Repository for the abuse_reports table.
 *
 * Behavior contracts shared across implementations:
 *
 *  - `record()` is dedupe-safe: a second report from the same reporter
 *    against the same target succeeds idempotently (returns
 *    `'duplicate'`) — the client never has to know.
 *
 *  - `countActive()` is the hot path for the auto-ban threshold check.
 *    Counts only reports newer than `ABUSE_REPORT_DECAY_DAYS` so
 *    historical strikes age out.
 *
 *  - `listForReported()` is for moderation review. Returns
 *    everything, including aged-out reports, so the moderator can
 *    see the full picture.
 *
 *  - There is no `delete()`. Reports survive the deletion of the
 *    reported user (no FK) as an audit trail; they're CASCADE-deleted
 *    when the reporter deletes their own account.
 */
export interface AbuseReport {
  id: number;
  reporterUserId: string;
  reportedUserId: string;
  reason: AbuseReportReason;
  detail?: string;
  createdAt: Date;
}

export type RecordResult = 'recorded' | 'duplicate';

export interface AbuseReportsRepo {
  /**
   * Record a report. Idempotent on (reporter, reported) — a second
   * call from the same reporter against the same target returns
   * `'duplicate'` instead of throwing.
   */
  record(args: {
    reporterUserId: string;
    reportedUserId: string;
    reason: AbuseReportReason;
    detail?: string;
  }): Promise<RecordResult>;

  /**
   * Count of distinct reporters with an active (within decay window)
   * report against `reportedUserId`. Used by the route to decide
   * whether the auto-ban threshold has been crossed.
   */
  countActive(reportedUserId: string): Promise<number>;

  /**
   * All reports against `reportedUserId`, newest first. For moderation
   * review post-ban; includes aged-out reports.
   */
  listForReported(reportedUserId: string): Promise<AbuseReport[]>;
}

// ─────────────────────────────────────────────────────────────────────
// In-memory implementation — used by tests and the dev validator path.
// Same dedup + decay semantics as the Drizzle impl.
// ─────────────────────────────────────────────────────────────────────
export class InMemoryAbuseReportsRepo implements AbuseReportsRepo {
  private rows: AbuseReport[] = [];
  private nextId = 1;
  private decayMs = ABUSE_REPORT_DECAY_DAYS * 24 * 60 * 60 * 1000;

  /**
   * Tests can shrink the decay window to make threshold-trip easier
   * to assert on (e.g. 1s decay so an aged-out report is observable
   * within a vitest deadline). Default matches production.
   */
  setDecayMs(ms: number): void {
    this.decayMs = ms;
  }

  async record({
    reporterUserId,
    reportedUserId,
    reason,
    detail,
  }: {
    reporterUserId: string;
    reportedUserId: string;
    reason: AbuseReportReason;
    detail?: string;
  }): Promise<RecordResult> {
    const existing = this.rows.find(
      (r) => r.reporterUserId === reporterUserId && r.reportedUserId === reportedUserId,
    );
    if (existing) return 'duplicate';
    this.rows.push({
      id: this.nextId++,
      reporterUserId,
      reportedUserId,
      reason,
      detail,
      createdAt: new Date(),
    });
    return 'recorded';
  }

  async countActive(reportedUserId: string): Promise<number> {
    const cutoff = Date.now() - this.decayMs;
    return this.rows.filter(
      (r) => r.reportedUserId === reportedUserId && r.createdAt.getTime() > cutoff,
    ).length;
  }

  async listForReported(reportedUserId: string): Promise<AbuseReport[]> {
    return this.rows
      .filter((r) => r.reportedUserId === reportedUserId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /** Test-only helper: drop everything. */
  reset(): void {
    this.rows = [];
    this.nextId = 1;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Drizzle / Postgres implementation
// ─────────────────────────────────────────────────────────────────────
export class DrizzleAbuseReportsRepo implements AbuseReportsRepo {
  constructor(private db: Db) {}

  async record({
    reporterUserId,
    reportedUserId,
    reason,
    detail,
  }: {
    reporterUserId: string;
    reportedUserId: string;
    reason: AbuseReportReason;
    detail?: string;
  }): Promise<RecordResult> {
    const result = await this.db
      .insert(abuseReports)
      .values({
        reporterUserId,
        reportedUserId,
        reason,
        detail,
      })
      // `onConflictDoNothing` on the (reporter, reported) unique
      // constraint is the SQL-level dedup. Drizzle returns an empty
      // array when the conflict swallowed the insert.
      .onConflictDoNothing({
        target: [abuseReports.reporterUserId, abuseReports.reportedUserId],
      })
      .returning({ id: abuseReports.id });
    return result.length > 0 ? 'recorded' : 'duplicate';
  }

  async countActive(reportedUserId: string): Promise<number> {
    // Window is expressed in SQL — keeps the index-friendly predicate
    // (reported_user_id, created_at) in one round trip.
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(abuseReports)
      .where(
        and(
          eq(abuseReports.reportedUserId, reportedUserId),
          gt(
            abuseReports.createdAt,
            sql`NOW() - (${ABUSE_REPORT_DECAY_DAYS} * INTERVAL '1 day')`,
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async listForReported(reportedUserId: string): Promise<AbuseReport[]> {
    const rows = await this.db
      .select()
      .from(abuseReports)
      .where(eq(abuseReports.reportedUserId, reportedUserId))
      .orderBy(sql`${abuseReports.createdAt} DESC`);
    return rows.map((r) => ({
      id: r.id,
      reporterUserId: r.reporterUserId,
      reportedUserId: r.reportedUserId,
      reason: r.reason as AbuseReportReason,
      detail: r.detail ?? undefined,
      createdAt: r.createdAt,
    }));
  }
}
