import { eq } from 'drizzle-orm';
import { getDb } from './client.js';
import { deletedHandles } from './schema.js';

type Db = ReturnType<typeof getDb>;

/**
 * Repository for the `deleted_handles` tombstone table. See
 * `infra/migrations/0020_deleted_handles.sql` for the rationale.
 *
 * Tiny surface area on purpose — this is a fact-keeper, not a hot
 * path. Consumers:
 *
 *   - `DELETE /v1/users/me` route writes the row in the same
 *     transaction window as the user delete.
 *   - `GET /v1/users/:handle` route reads `isDeleted()` to return 410
 *     instead of 404 when the handle is in this table.
 *   - `POST /v1/prekeys/bundle` route reads `isDeleted()` to refuse
 *     fresh sessions against a ghost.
 *   - WS `message` handler reads `isDeleted()` to emit
 *     `peer_deleted` instead of buffering when the recipient is gone.
 */
export interface DeletedHandlesRepo {
  /** Record that a handle was deleted. Idempotent — re-recording the
   *  same handle is a no-op (preserves the original `deletedAt`). */
  record(handle: string): Promise<void>;
  /** True when the handle is in the tombstone set. */
  isDeleted(handle: string): Promise<boolean>;
  /** Returns the deletion timestamp, or undefined if not deleted. */
  findDeletedAt(handle: string): Promise<Date | undefined>;
}

export class InMemoryDeletedHandlesRepo implements DeletedHandlesRepo {
  private deletedAt = new Map<string, Date>();

  async record(handle: string): Promise<void> {
    if (this.deletedAt.has(handle)) return; // preserve original timestamp
    this.deletedAt.set(handle, new Date());
  }

  async isDeleted(handle: string): Promise<boolean> {
    return this.deletedAt.has(handle);
  }

  async findDeletedAt(handle: string): Promise<Date | undefined> {
    return this.deletedAt.get(handle);
  }

  reset(): void {
    this.deletedAt.clear();
  }
}

export class DrizzleDeletedHandlesRepo implements DeletedHandlesRepo {
  constructor(private db: Db) {}

  async record(handle: string): Promise<void> {
    // `ON CONFLICT DO NOTHING` preserves the original `deleted_at` if
    // the handle was already tombstoned. Defensive against a redundant
    // double-call from the DELETE route (idempotency).
    await this.db
      .insert(deletedHandles)
      .values({ handle })
      .onConflictDoNothing({ target: deletedHandles.handle });
  }

  async isDeleted(handle: string): Promise<boolean> {
    const rows = await this.db
      .select({ h: deletedHandles.handle })
      .from(deletedHandles)
      .where(eq(deletedHandles.handle, handle))
      .limit(1);
    return rows.length > 0;
  }

  async findDeletedAt(handle: string): Promise<Date | undefined> {
    const rows = await this.db
      .select({ at: deletedHandles.deletedAt })
      .from(deletedHandles)
      .where(eq(deletedHandles.handle, handle))
      .limit(1);
    return rows[0]?.at;
  }
}
