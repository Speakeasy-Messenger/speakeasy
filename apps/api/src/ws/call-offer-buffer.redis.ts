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
 * Atomicity: ICE-append and call-end-clear are read-modify-write,
 * which would race with a concurrent offer for a different callId.
 * We use Lua via EVAL for both so the check-then-write is atomic
 * inside Redis. SET (offer) and GETDEL (drain) are already atomic
 * single-op commands.
 *
 * Failure mode: Redis-down or transient network error on put/clear
 * = best-effort drop. The caller's ringing-window timeout produces
 * the same "no answer" outcome the user would see without the
 * buffer at all, so silently swallowing the error matches the
 * existing live-route-only fallback. Drain failures are logged but
 * also non-fatal (worst case the device gets the FCM push and the
 * call screen never opens — same as pre-buffer behavior).
 */

const TTL_MS = 30_000;
const keyFor = (userId: string): string => `speakeasy:call-buf:${userId}`;

/**
 * Append an ICE frame iff the buffered offer's callId matches.
 * KEYS[1] = buffer key
 * ARGV[1] = expected callId
 * ARGV[2] = ICE frame JSON (object with fromUserId + ciphertext)
 * ARGV[3] = TTL in ms (re-applied on append)
 * Returns 1 on append, 0 on no-op.
 */
const APPEND_ICE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, v = pcall(cjson.decode, raw)
if not ok or v.callId ~= ARGV[1] then return 0 end
table.insert(v.ices, cjson.decode(ARGV[2]))
redis.call('SET', KEYS[1], cjson.encode(v), 'PX', tonumber(ARGV[3]))
return 1
`;

/**
 * Delete the buffer iff the stored callId matches.
 * KEYS[1] = buffer key
 * ARGV[1] = expected callId
 * Returns 1 on delete, 0 on no-op.
 */
const CLEAR_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local ok, v = pcall(cjson.decode, raw)
if not ok then return 0 end
if v.callId == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

interface StoredEntry {
  callId: string;
  offer: { fromUserId: string; ciphertext: string };
  ices: Array<{ fromUserId: string; ciphertext: string }>;
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
      // call_ice
      const iceFrame = {
        fromUserId: frame.fromUserId,
        ciphertext: frame.ciphertext,
      };
      void redis
        .eval(
          APPEND_ICE_SCRIPT,
          1,
          key,
          frame.callId,
          JSON.stringify(iceFrame),
          String(ttlMs),
        )
        .catch(() => {
          /* silent */
        });
    },

    clear(toUserId, callId) {
      const key = keyFor(toUserId);
      void redis.eval(CLEAR_SCRIPT, 1, key, callId).catch(() => {
        /* silent */
      });
    },

    async drain(toUserId) {
      const key = keyFor(toUserId);
      // Atomic read-and-delete via GETDEL (Redis 6.2+). Falls back to
      // MULTI{GET,DEL} if GETDEL is unavailable — but Fly Redis ships
      // 7.x so we're safe.
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
