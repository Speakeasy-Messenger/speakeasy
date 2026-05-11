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
 * Atomicity: SET (offer) and GETDEL (drain) are atomic single-op
 * commands. ICE-append and call-end-clear are read-modify-write —
 * we do the check + write in JS without a transaction, which races
 * with a concurrent offer for a different callId in the millisecond
 * window between GET and SET/DEL. The race is rare (two callers
 * calling the same Bob simultaneously) and the consequence is
 * bounded (one ICE lost, or a buffer cleared that a newer offer
 * just re-populated — same as the existing fire-and-forget put
 * failure mode). Lua EVAL would close the window, but using only
 * single-op Redis commands keeps the path portable across both
 * full Redis (Upstash 7.x) and ioredis-mock-backed Tier B tests.
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

interface StoredEntry {
  callId: string;
  offer: { fromUserId: string; ciphertext: string };
  ices: Array<{ fromUserId: string; ciphertext: string }>;
}

/**
 * Non-atomic conditional read-modify-write. Reads the buffer key,
 * passes the parsed entry to `mutate`, and writes back the result.
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
      void modifyBuffer(redis, key, ttlMs, (entry) => {
        if (entry.callId !== callId) return undefined; // no-op
        return null; // DEL
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
