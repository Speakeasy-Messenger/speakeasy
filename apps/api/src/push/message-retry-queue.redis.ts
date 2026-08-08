import type { Redis } from 'ioredis';
import type { MessageRetryQueue } from './message-retry-queue.js';

/**
 * Redis-backed fallback queue — shared across API instances.
 *
 * One sorted set:
 *   speakeasy:push-fallback  →  { messageId: fireAtMs, ... }
 *
 * `enqueue` ZADDs the id scored by its fire time (a re-enqueue just updates the
 * score — one entry per id). `claimDue` runs a Lua script that fetches the due
 * members AND removes them in a single atomic step, so on a 2-machine deploy
 * each due message is processed by exactly one instance (no double-banner).
 *
 * Best-effort: a Redis error on enqueue just skips the fallback for that one
 * message (the message itself is still safe in the Postgres relay buffer); a
 * claim error yields an empty batch (retried on the next tick).
 */

const KEY = 'speakeasy:push-retry';

// KEYS[1] = zset, ARGV[1] = now (ms), ARGV[2] = limit.
// Fetch due members, remove them, return them — atomically.
const CLAIM_LUA = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #due > 0 then
  redis.call('ZREM', KEYS[1], unpack(due))
end
return due
`;

export function createRedisMessageRetryQueue(
  redis: Redis,
  opts?: { key?: string },
): MessageRetryQueue {
  const key = opts?.key ?? KEY;
  return {
    enqueue(messageId, fireAtMs) {
      void redis.zadd(key, fireAtMs, messageId).catch(() => {
        /* best-effort — see file header */
      });
    },
    async claimDue(nowMs, limit) {
      try {
        const res = (await redis.eval(
          CLAIM_LUA,
          1,
          key,
          String(nowMs),
          String(limit),
        )) as string[] | null;
        return Array.isArray(res) ? res : [];
      } catch {
        return [];
      }
    },
  };
}
