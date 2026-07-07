import type { MessagesRepo } from '../db/messages.js';
import type { PushProvider } from './push.js';
import { FALLBACK_CLAIM_LIMIT, type PushFallbackQueue } from './push-fallback-queue.js';

export interface PushFallbackWorkerDeps {
  queue: PushFallbackQueue;
  messages: MessagesRepo;
  push: PushProvider;
  log?: { warn: (obj: unknown, msg?: string) => void };
  /** Poll interval. Default 10s. */
  intervalMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Drains due fallback re-checks. For each claimed messageId, if its relay row
 * still exists — i.e. no device ever acked, so the original rich data-only push
 * never landed (killed/Doze'd Android app) — fire a generic OS-rendered banner
 * (`forceBanner`, no ciphertext) so the message stops being silently invisible.
 * A message that WAS delivered left no row, so it gets nothing and its decrypted
 * preview is untouched.
 *
 * Returns a stop() that clears the interval.
 */
export function startPushFallbackWorker(deps: PushFallbackWorkerDeps): () => void {
  const intervalMs = deps.intervalMs ?? 10_000;
  const now = deps.now ?? ((): number => Date.now());
  let inTick = false;

  const tick = async (): Promise<void> => {
    if (inTick) return; // never overlap ticks (a slow FCM batch shouldn't stack)
    inTick = true;
    try {
      const ids = await deps.queue.claimDue(now(), FALLBACK_CLAIM_LIMIT);
      for (const id of ids) {
        try {
          const row = await deps.messages.getById(id);
          // Row gone → the message was delivered + acked → the rich push
          // landed. Nothing to do; leave the preview alone.
          if (!row) continue;
          await deps.push.notifyDelivery({
            userId: row.recipientId,
            conversationId: row.conversation,
            msgType: row.msgType,
            // Sealed-sender messages hide the sender from the server surface.
            senderId: row.sealed ? undefined : row.senderId,
            messageId: row.id,
            // Force an OS-rendered banner even for 'rich' devices, and carry no
            // ciphertext (the app is presumed dead — it can't decrypt anyway).
            forceBanner: true,
          });
        } catch (err) {
          deps.log?.warn({ err, messageId: id }, 'push fallback re-check failed');
        }
      }
    } catch (err) {
      deps.log?.warn({ err }, 'push fallback worker tick failed');
    } finally {
      inTick = false;
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  // Don't hold the event loop open just for this timer.
  if (typeof handle.unref === 'function') handle.unref();
  return () => clearInterval(handle);
}
