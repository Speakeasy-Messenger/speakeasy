import type { Redis } from 'ioredis';
import { ACK_BUFFER_CAP, type AckBuffer, type BufferedAck } from './ack-buffer.js';

/**
 * Redis-backed ack buffer — shared across API instances.
 *
 * Same semantics as the in-memory variant but global, so the sender
 * can reconnect to either fly machine and still drain acks that the
 * *other* machine buffered while handling the recipient.
 *
 * One Redis list per sender userId:
 *   speakeasy:ack-buf:{userId}  →  [JSON BufferedAck, ...]
 *
 * `put` RPUSHes the ack, LTRIMs to the cap, and refreshes a 7-day TTL —
 * all in one pipeline. `drain` reads and deletes the list inside a
 * MULTI so a concurrent put can't be lost between the read and the
 * delete.
 *
 * Best-effort: a Redis error on put drops that one receipt's catch-up
 * (the live path may still have delivered it); a drain error yields an
 * empty list (same as no buffered acks). Neither is fatal.
 */

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — matches the relay buffer.
const keyFor = (userId: string): string => `speakeasy:ack-buf:${userId}`;

export function createRedisAckBuffer(
  redis: Redis,
  opts?: { ttlMs?: number },
): AckBuffer {
  const ttlMs = opts?.ttlMs ?? TTL_MS;
  return {
    put(senderId, ack) {
      const key = keyFor(senderId);
      void redis
        .multi()
        .rpush(key, JSON.stringify(ack))
        .ltrim(key, -ACK_BUFFER_CAP, -1)
        .pexpire(key, ttlMs)
        .exec()
        .catch(() => {
          /* best-effort — see file header */
        });
    },
    async drain(senderId) {
      const key = keyFor(senderId);
      let rows: string[];
      try {
        // MULTI{LRANGE, DEL} — atomic read-and-clear.
        const res = await redis.multi().lrange(key, 0, -1).del(key).exec();
        const lrange = res?.[0]?.[1];
        rows = Array.isArray(lrange) ? (lrange as string[]) : [];
      } catch {
        return [];
      }
      const out: BufferedAck[] = [];
      for (const raw of rows) {
        try {
          out.push(JSON.parse(raw) as BufferedAck);
        } catch {
          /* skip a corrupt entry */
        }
      }
      return out;
    },
  };
}
