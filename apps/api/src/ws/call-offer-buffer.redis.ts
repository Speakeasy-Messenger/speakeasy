import type { Redis } from 'ioredis';
import type { BufferedCallFrame, CallOfferBuffer } from './call-offer-buffer.js';

/**
 * Redis-backed call-offer buffer.
 *
 * Same semantics as the in-memory variant but shared across API
 * instances via Redis. Fixes the failure mode the in-memory variant
 * couldn't: a callee whose WS was closed for push routing, push
 * wakes the device, and the WS reconnects to a *different* fly
 * machine than the one that buffered the offer. With this variant
 * the buffer is global, so any instance can drain.
 *
 * Storage shape — one key per recipient userId:
 *   speakeasy:call-buf:{userId}  →  JSON {callId, offer, ices: [...]}
 *   PEXPIRE 30000  (matches the ringing window)
 *
 * Atomicity: SET (offer), GETDEL (drain), and Lua-backed conditional
 * DEL (clear) are atomic Redis operations. ICE append remains a
 * read-modify-write operation; a concurrent offer can supersede it.
 *
 * Failure mode: Redis-down or transient network error on put/clear
 * = best-effort drop. The caller's ringing-window timeout produces
 * the same "no answer" outcome the user would see without the
 * buffer at all, so silently swallowing the error matches the
 * existing live-route-only fallback. Drain failures are also non-fatal and
 * return no frames (worst case the device gets the FCM push and the call
 * screen never opens — same as pre-buffer behavior).
 */

const TTL_MS = 30_000;
const keyFor = (userId: string): string => `speakeasy:call-buf:${userId}`;

const CLEAR_IF_MATCHING_LUA = `
local raw = redis.call('GET', KEYS[1])
if not raw then
  return 0
end
if string.sub(raw, 1, string.len(ARGV[1])) ~= ARGV[1] then
  return 0
end
return redis.call('DEL', KEYS[1])
`;

const callIdPrefix = (callId: string): string => `{"callId":${JSON.stringify(callId)},`;

interface StoredEntry {
  callId: string;
  offer: { fromUserId: string; ciphertext: string };
  ices: Array<{ fromUserId: string; ciphertext: string }>;
}

/**
 * Non-atomic conditional read-modify-write for ICE append. Reads the
 * buffer key, passes the parsed entry to `mutate`, and writes back the result.
 * `mutate` returns:
 *   - a new entry → SET it (with PX ttl)
 *   - `null`      → DEL the key
 *   - `undefined` → no-op
 *
 * Concurrent writers between the GET and the SET/DEL can race —
 * see file header. Returns true on a successful mutation, false on
 * any abort path (no key, parse failure, Redis error, mutate
 * declined).
 */
async function modifyBuffer(
  redis: Redis,
  key: string,
  ttlMs: number,
  mutate: (entry: StoredEntry) => StoredEntry | null | undefined,
): Promise<boolean> {
  try {
    const raw = await redis.get(key);
    if (!raw) return false;
    let entry: StoredEntry;
    try {
      entry = JSON.parse(raw) as StoredEntry;
    } catch {
      return false;
    }
    const next = mutate(entry);
    if (next === undefined) return false;
    if (next === null) {
      await redis.del(key);
    } else {
      await redis.set(key, JSON.stringify(next), 'PX', ttlMs);
    }
    return true;
  } catch {
    // Best-effort — drop silently per file header.
    return false;
  }
}

export function createRedisCallOfferBuffer(
  redis: Redis,
  opts?: { ttlMs?: number },
): CallOfferBuffer {
  const ttlMs = opts?.ttlMs ?? TTL_MS;

  return {
    put(toUserId, frame) {
      const key = keyFor(toUserId);
      if (frame.type === 'call_offer') {
        const entry: StoredEntry = {
          callId: frame.callId,
          offer: { fromUserId: frame.fromUserId, ciphertext: frame.ciphertext },
          ices: [],
        };
        // SET-with-PX is atomic; replaces any prior buffer for this
        // recipient. No EXISTS check — newer offers always win.
        void redis.set(key, JSON.stringify(entry), 'PX', ttlMs).catch(() => {
          /* silent — see file header */
        });
        return;
      }
      // call_ice — append only if the stored offer's callId matches.
      const iceFrame = {
        fromUserId: frame.fromUserId,
        ciphertext: frame.ciphertext,
      };
      void modifyBuffer(redis, key, ttlMs, (entry) => {
        if (entry.callId !== frame.callId) return undefined; // no-op
        return { ...entry, ices: [...entry.ices, iceFrame] };
      });
    },

    clear(toUserId, callId) {
      const key = keyFor(toUserId);
      void redis.eval(CLEAR_IF_MATCHING_LUA, 1, key, callIdPrefix(callId)).catch(() => {
        /* silent — see file header */
      });
    },

    async drain(toUserId) {
      const key = keyFor(toUserId);
      // Atomic read-and-delete via GETDEL (Redis 6.2+). Fly Redis ships 7.x;
      // if the command is unavailable or Redis fails, draining is best-effort.
      let raw: string | null;
      try {
        raw = await redis.getdel(key);
      } catch {
        return [];
      }
      if (!raw) return [];
      let entry: StoredEntry;
      try {
        entry = JSON.parse(raw) as StoredEntry;
      } catch {
        return [];
      }
      const out: BufferedCallFrame[] = [
        {
          type: 'call_offer',
          fromUserId: entry.offer.fromUserId,
          callId: entry.callId,
          ciphertext: entry.offer.ciphertext,
        },
        ...entry.ices.map((i) => ({
          type: 'call_ice' as const,
          fromUserId: i.fromUserId,
          callId: entry.callId,
          ciphertext: i.ciphertext,
        })),
      ];
      return out;
    },

    size() {
      // Test seam — Redis variant doesn't track this; tests that need
      // a count should query the Redis instance directly.
      return 0;
    },
    shutdown() {
      /* nothing to clean up — Redis connection is owned by the caller */
    },
  };
}
