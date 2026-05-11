/**
 * Persistent server-side event log for diagnostics fly's 5-minute
 * stdout buffer can't reach.
 *
 * Surgical: only paths that explicitly call `record()` land here.
 * The push path is the first consumer — when the next report shape
 * "@<peer> didn't get a push 20 minutes ago" arrives, we can answer
 * it with a SQL query instead of "please reproduce while I tail."
 *
 * `record()` is fire-and-forget by convention at call sites: a
 * dropped row is preferable to blocking the WS hop on a DB write.
 * Errors are caught + warned via the caller's logger.
 */

export interface EventLogRecord {
  /**
   * Dot-namespaced event type. Conventions:
   *   - "push.attempted"          — one row per notifyDelivery() with
   *                                 device count + success/failure
   *                                 totals + token preview.
   *   - "push.no_devices"         — recipient has no push tokens
   *                                 registered (drops silently).
   *   - "push.fcm_failure"        — at least one FCM send failed;
   *                                 payload includes error messages.
   *
   * Future event types should keep the `<surface>.<verb>` shape so
   * grouping by surface stays trivial.
   */
  eventType: string;
  /** Recipient or originator userId if applicable. Indexed. */
  userId?: string;
  /** Free-form structured payload. JSONB on the wire. */
  payload?: Record<string, unknown>;
}

export interface EventLogRepo {
  record(entry: EventLogRecord): Promise<void>;
  /**
   * Read recent rows for a specific user. Used by ad-hoc admin
   * queries (none in production yet — psql via `flyctl postgres
   * connect` for now).
   */
  recentForUser(userId: string, limit?: number): Promise<RecordedEvent[]>;
}

export interface RecordedEvent {
  id: number;
  ts: Date;
  eventType: string;
  userId: string | null;
  payload: Record<string, unknown>;
}
