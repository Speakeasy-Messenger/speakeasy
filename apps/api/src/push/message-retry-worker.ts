import type { MessagesRepo, BufferedMessage } from '../db/messages.js';
import type { PushProvider } from './push.js';
import {
  RETRY_CLAIM_LIMIT,
  RETRY_DELAY_MS,
  type MessageRetryQueue,
} from './message-retry-queue.js';

export interface MessageRetryWorkerDeps {
  queue: MessageRetryQueue;
  messages: MessagesRepo;
  push: PushProvider;
  /** Plaintext room names for group banners: groupId → name. Optional. */
  groupName?: (groupId: string) => Promise<string | undefined>;
  log?: { warn: (obj: unknown, msg?: string) => void };
  /** Poll interval. Default 10s. */
  intervalMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
}

/**
 * Give up retrying once the message is this old. A phone still unreachable
 * after ~3 minutes is genuinely offline / force-killed / Doze-locked; more
 * pushes won't wake it, and it will drain the relay row on next foreground.
 * (Three attempts at RETRY_DELAY_MS: ~45s, ~90s, ~135s.)
 */
export const RETRY_MAX_AGE_MS = 3 * 60_000;

/**
 * Re-sends the ORIGINAL push for a message whose relay row is still present at
 * its retry time — i.e. no device acked, over WS or the HTTP delivered-receipt,
 * so the phone never processed the first push (Doze'd / OEM-killed).
 *
 * The retry is byte-for-byte the same rich data push: same ciphertext, same
 * sender/group banner copy. Either it lands and the recipient gets the real,
 * decrypted notification, or it doesn't and they see nothing — never a
 * stripped "New message" banner. If the row survives past RETRY_MAX_AGE_MS the
 * message is abandoned (the earlier design's contentless fallback is gone).
 *
 * Returns a stop() that clears the interval.
 */
export function startMessageRetryWorker(deps: MessageRetryWorkerDeps): () => void {
  const intervalMs = deps.intervalMs ?? 10_000;
  const now = deps.now ?? ((): number => Date.now());
  let inTick = false;

  const tick = async (): Promise<void> => {
    if (inTick) return; // never overlap ticks
    inTick = true;
    try {
      const ids = await deps.queue.claimDue(now(), RETRY_CLAIM_LIMIT);
      for (const id of ids) {
        try {
          const row = await deps.messages.getById(id);
          // Row gone → acked (WS or HTTP receipt) → the push landed. Done.
          if (!row) continue;
          // Too old → the phone is unreachable; stop retrying and let the
          // next foreground drain it. Do NOT re-enqueue.
          if (now() - row.createdAt.getTime() >= RETRY_MAX_AGE_MS) continue;

          await resend(deps, row);
          // Still undelivered and within the window → schedule the next retry.
          deps.queue.enqueue(id, now() + RETRY_DELAY_MS);
        } catch (err) {
          deps.log?.warn({ err, messageId: id }, 'message retry re-check failed');
        }
      }
    } catch (err) {
      deps.log?.warn({ err }, 'message retry worker tick failed');
    } finally {
      inTick = false;
    }
  };

  const handle = setInterval(() => void tick(), intervalMs);
  // Don't keep the process alive for the poll loop.
  (handle as unknown as { unref?: () => void }).unref?.();
  return () => clearInterval(handle);
}

async function resend(deps: MessageRetryWorkerDeps, row: BufferedMessage): Promise<void> {
  const groupName =
    row.msgType === 'group' && deps.groupName
      ? await deps.groupName(row.conversation).catch(() => undefined)
      : undefined;
  await deps.push.notifyDelivery({
    userId: row.recipientId,
    conversationId: row.conversation,
    msgType: row.msgType,
    // Sealed-sender messages hide the sender from the server surface.
    senderId: row.sealed ? undefined : row.senderId,
    groupName,
    messageId: row.id,
    sentAt: row.createdAt.getTime(),
    // The same E2E payload the recipient's headless handler decrypts. push
    // .fcm-apns re-applies the rich/size/sealed gates, exactly as on first send.
    ciphertext: row.ciphertext.toString('base64'),
  });
}
