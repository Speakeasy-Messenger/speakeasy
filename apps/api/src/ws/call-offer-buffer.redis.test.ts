import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedisCallOfferBuffer } from './call-offer-buffer.redis.js';

/**
 * Hand-rolled fake Redis covering just the surface this buffer uses:
 *  - set(key, value, 'PX', ttlMs) — replaces, applies TTL
 *  - getdel(key) — atomic GET + DEL
 *  - eval(script, numKeys, key, ...argv) — runs our two Lua scripts
 *
 * The Lua scripts are simulated by sniffing on a literal substring,
 * which would be fragile if we had many — for two scripts the
 * trade-off is fine and keeps the test free of a real redis dep.
 */
function makeFakeRedis(): {
  redis: Redis;
  store: Map<string, { value: string; expiresAt: number }>;
} {
  const store = new Map<string, { value: string; expiresAt: number }>();

  function get(key: string): string | null {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt && Date.now() > e.expiresAt) {
      store.delete(key);
      return null;
    }
    return e.value;
  }

  const redis = {
    async set(key: string, value: string, _flag?: string, ttlMs?: number) {
      const expiresAt = ttlMs ? Date.now() + ttlMs : 0;
      store.set(key, { value, expiresAt });
      return 'OK';
    },
    async getdel(key: string) {
      const v = get(key);
      store.delete(key);
      return v;
    },
    async eval(script: string, _numKeys: number, key: string, ...argv: string[]) {
      if (script.includes('table.insert(v.ices')) {
        // APPEND_ICE_SCRIPT
        const [expectedCallId, iceJson, ttlMsStr] = argv;
        const raw = get(key);
        if (!raw) return 0;
        let parsed: {
          callId: string;
          offer: { fromUserId: string; ciphertext: string };
          ices: Array<{ fromUserId: string; ciphertext: string }>;
        };
        try {
          parsed = JSON.parse(raw);
        } catch {
          return 0;
        }
        if (parsed.callId !== expectedCallId) return 0;
        parsed.ices.push(JSON.parse(iceJson!) as (typeof parsed.ices)[number]);
        store.set(key, {
          value: JSON.stringify(parsed),
          expiresAt: Date.now() + Number(ttlMsStr),
        });
        return 1;
      }
      if (script.includes("redis.call('DEL', KEYS[1])")) {
        // CLEAR_SCRIPT
        const [expectedCallId] = argv;
        const raw = get(key);
        if (!raw) return 0;
        try {
          const parsed = JSON.parse(raw) as { callId: string };
          if (parsed.callId === expectedCallId) {
            store.delete(key);
            return 1;
          }
        } catch {
          return 0;
        }
        return 0;
      }
      throw new Error('unrecognized script in fake redis');
    },
  } as unknown as Redis;

  return { redis, store };
}

const OFFER = {
  type: 'call_offer' as const,
  fromUserId: 'alice',
  callId: 'call-001',
  ciphertext: 'b3Nhcg==',
};
const ICE_A = {
  type: 'call_ice' as const,
  fromUserId: 'alice',
  callId: 'call-001',
  ciphertext: 'aWNlMQ==',
};
const ICE_B = {
  type: 'call_ice' as const,
  fromUserId: 'alice',
  callId: 'call-001',
  ciphertext: 'aWNlMg==',
};

// Allow the fire-and-forget puts to settle before the next op runs.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('createRedisCallOfferBuffer', () => {
  it('drains a buffered offer', async () => {
    const { redis } = makeFakeRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await flush();
    const out = await buf.drain('bob');
    expect(out).toEqual([OFFER]);
  });

  it('preserves offer + ICE ordering across instances', async () => {
    const { redis } = makeFakeRedis();
    // First instance puts offer + ICE; second instance drains.
    const writer = createRedisCallOfferBuffer(redis);
    const reader = createRedisCallOfferBuffer(redis);
    writer.put('bob', OFFER);
    await flush();
    writer.put('bob', ICE_A);
    writer.put('bob', ICE_B);
    await flush();
    const out = await reader.drain('bob');
    expect(out).toEqual([OFFER, ICE_A, ICE_B]);
  });

  it('ignores ICE whose callId does not match the buffered offer', async () => {
    const { redis } = makeFakeRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await flush();
    buf.put('bob', { ...ICE_A, callId: 'call-999' });
    await flush();
    expect(await buf.drain('bob')).toEqual([OFFER]);
  });

  it('replaces a prior buffered call when a new offer arrives', async () => {
    const { redis } = makeFakeRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await flush();
    buf.put('bob', ICE_A);
    await flush();
    const offer2 = { ...OFFER, callId: 'call-002', ciphertext: 'bmV3' };
    buf.put('bob', offer2);
    await flush();
    expect(await buf.drain('bob')).toEqual([offer2]);
  });

  it('clear() removes only the matching callId', async () => {
    const { redis, store } = makeFakeRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await flush();
    buf.clear('bob', 'call-999');
    await flush();
    expect(store.size).toBe(1);
    buf.clear('bob', 'call-001');
    await flush();
    expect(store.size).toBe(0);
    expect(await buf.drain('bob')).toEqual([]);
  });

  it('drain returns [] when nothing is buffered', async () => {
    const { redis } = makeFakeRedis();
    const buf = createRedisCallOfferBuffer(redis);
    expect(await buf.drain('nobody')).toEqual([]);
  });

  it('cross-instance: writer + reader run on independent buffer wrappers', async () => {
    // This is the rc.52 → rc.53 failure mode: caller's instance
    // buffers, callee reconnects on a different instance and drains.
    const { redis } = makeFakeRedis();
    const writer = createRedisCallOfferBuffer(redis);
    const reader = createRedisCallOfferBuffer(redis);
    writer.put('bob', OFFER);
    writer.put('bob', ICE_A);
    await flush();
    expect(await reader.drain('bob')).toEqual([OFFER, ICE_A]);
    // After drain the writer also sees an empty buffer.
    expect(await writer.drain('bob')).toEqual([]);
  });

  it('drain swallows malformed JSON gracefully', async () => {
    const { redis, store } = makeFakeRedis();
    store.set('speakeasy:call-buf:bob', { value: 'not-json{', expiresAt: 0 });
    const buf = createRedisCallOfferBuffer(redis);
    expect(await buf.drain('bob')).toEqual([]);
  });
});
