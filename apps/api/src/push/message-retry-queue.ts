/**
 * Delayed message-RETRY queue.
 *
 * Rich-mode Android pushes are data-only, so the headless handler decrypts and
 * renders the real text — but a Doze'd / OEM-killed app never runs that handler
 * and the message stays invisible until the app is opened. This queue schedules
 * a re-check ~45s after send: if the message's relay row is STILL present then,
 * no device has acked, so the phone never processed the push — and we RE-SEND
 * THE ORIGINAL push (same ciphertext, same rich payload), not a stripped
 * "New message" banner. Either the retry lands and the user gets the real,
 * decrypted notification, or it doesn't and they see nothing until they open
 * the app — never a contentless downgrade.
 *
 * A message that WAS delivered leaves no row (the ack deleted it), so it is
 * never retried. The ack can arrive over the WebSocket (foreground) OR the
 * HTTP delivered-receipt endpoint (background push handler) — the latter is
 * why a backgrounded-but-alive phone doesn't get a needless retry.
 *
 * Bounded: each message is retried at most RETRY_MAX_ATTEMPTS times, then
 * given up (the phone is genuinely unreachable — killed, offline, or Doze
 * won't wake it; nothing more we can do until it foregrounds).
 */
export interface MessageRetryQueue {
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
export const RETRY_DELAY_MS = 45_000;

/** Max entries a single worker tick claims (bounds one tick's FCM fan-out). */
export const RETRY_CLAIM_LIMIT = 200;

/**
 * In-memory variant — tests + single-instance dev. A 2-machine deploy needs the
 * Redis variant so a fallback enqueued on one instance is claimed exactly once
 * across the fleet.
 */
export function createMessageRetryQueue(): MessageRetryQueue {
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
