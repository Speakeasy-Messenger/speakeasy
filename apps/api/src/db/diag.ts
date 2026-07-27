/**
 * Beta-only diagnostic log uploads.
 *
 * Backs `POST /v1/diag` — the durable sink for the mobile diag ring
 * buffer, streamed automatically on abnormal call ends + crashes so we
 * stop asking testers to copy-paste logs. Metadata only: `entries` is the
 * client's already-redacted buffer (see mobile `diag/log.ts`) and the
 * route strips it to the known keys below before it ever reaches `insert`.
 *
 * Follows the repo trio pattern (interface here, Drizzle + in-memory
 * impls alongside). Retention lives on the repo (`purgeOlderThan`) because
 * this service has no periodic-job runner yet — see migrations/0023.
 */

/**
 * A single diagnostic entry. Mirrors the client `DiagEntry`
 * (apps/mobile/src/diag/log.ts). These are the ONLY keys the route
 * accepts — anything else is stripped as defense-in-depth so a future
 * client can't smuggle a plaintext field through.
 */
export interface DiagEntry {
  /** Wall-clock ms. */
  t: number;
  /** Short grouping tag (e.g. 'call', 'ws', 'auth'). */
  tag: string;
  /** Free-form message. */
  msg: string;
  /** Optional structured context. */
  ctx?: Record<string, unknown>;
}

/** Input to `insert` — the server stamps id + createdAt. */
export interface DiagUploadRecord {
  userId: string;
  /** Present only for call-scoped uploads. */
  callId?: string;
  appVersion: string;
  reason: string;
  entries: DiagEntry[];
}

/** A stored row as read back by the list queries. */
export interface StoredDiagUpload {
  id: number;
  userId: string;
  callId: string | null;
  appVersion: string;
  reason: string;
  entries: DiagEntry[];
  createdAt: Date;
}

export interface DiagUploadsRepo {
  insert(record: DiagUploadRecord): Promise<void>;
  /** All uploads for one call — both sides of a failed call land here. */
  listByCallId(callId: string): Promise<StoredDiagUpload[]>;
  /** Recent uploads by one user, newest first. */
  listByUser(userId: string, limit?: number): Promise<StoredDiagUpload[]>;
  /** Retention sweep — delete rows older than `cutoff`. Returns count deleted. */
  purgeOlderThan(cutoff: Date): Promise<number>;
}
