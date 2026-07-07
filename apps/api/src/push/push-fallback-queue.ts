/**
 * Delayed "did the rich push actually land?" queue.
 *
 * Rich-mode Android pushes are data-only so the headless handler can decrypt +
 * render the real text — but a Doze'd / OEM-killed app never runs that handler,
 * so the message stays invisible until the user manually foregrounds (the
 * "messages dropped / no notification" report). This queue schedules a re-check
 * ~45s after send: if the message's relay row is still present by then (no
 * device acked → the rich push didn't land), the worker fires a generic,
 * OS-rendered banner as a guaranteed-delivery fallback. A delivered message
 * leaves no row, so it never gets a fallback — decrypted previews stay intact
 * for apps that were alive to process the original push.
 */
export interface PushFallbackQueue {
  /** Schedule a fallback re-check for `messageId` at `fireAtMs` (epoch ms). */
  enqueue(messageId: string, fireAtMs: number): void;
  /**
   * Atomically claim up to `limit` entries whose fire time is <= `nowMs`,
   * removing them so no other API instance re-processes the same message.
   * Returns the claimed message ids.
   */
  claimDue(nowMs: number, limit: number): Promise<string[]>;
}

/**
 * Delay before the fallback re-check. Long enough for a live app to receive the
 * rich data push, render it, and ack (deleting the row); short enough that a
 * killed app's recipient isn't left unaware for long.
 */
export const FALLBACK_DELAY_MS = 45_000;

/** Max entries a single worker tick claims (bounds one tick's FCM fan-out). */
export const FALLBACK_CLAIM_LIMIT = 200;

/**
 * In-memory variant — tests + single-instance dev. A 2-machine deploy needs the
 * Redis variant so a fallback enqueued on one instance is claimed exactly once
 * across the fleet.
 */
export function createPushFallbackQueue(): PushFallbackQueue {
  // messageId -> fireAtMs. One entry per message (a re-enqueue moves the
  // deadline rather than duplicating).
  const due = new Map<string, number>();
  return {
    enqueue(messageId, fireAtMs) {
      due.set(messageId, fireAtMs);
    },
    claimDue(nowMs, limit) {
      const out: string[] = [];
      for (const [id, at] of due) {
        if (at <= nowMs) {
          out.push(id);
          due.delete(id);
          if (out.length >= limit) break;
        }
      }
      return Promise.resolve(out);
    },
  };
}
