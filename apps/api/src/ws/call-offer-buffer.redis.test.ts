import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
// @ts-expect-error - ioredis-mock has no types but is API-compatible with ioredis
import RedisMock from 'ioredis-mock';
import { createRedisCallOfferBuffer } from './call-offer-buffer.redis.js';
import { raiseIoredisMockListenerLimit } from './redis-mock-listener-limit.test-util.js';

/**
 * Unit tests for the Redis-backed call-offer buffer.
 *
 * Run against ioredis-mock so the Lua EVAL and GETDEL paths the
 * production code actually executes are exercised end-to-end. Each
 * `new RedisMock()` shares an in-process emulated Redis with every
 * other instance — which is exactly the shared-Upstash analog we
 * want for cross-instance tests.
 */
function makeMockRedis(): Redis {
  raiseIoredisMockListenerLimit();
  return new RedisMock() as unknown as Redis;
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

// Allow the fire-and-forget puts/clears to settle before the next op
// runs. The ICE-append and clear paths do GET → conditional SET/DEL
// inside a `void modifyBuffer(...)` chain that needs a handful of
// microtasks plus the ioredis-mock command roundtrip; a small sleep
// is more reliable than counting microtask hops.
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function blockRedisGet(redis: Redis): {
  release: () => void;
  restore: () => void;
} {
  const originalGet = redis.get.bind(redis);
  let release = (): void => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(redis, 'get').mockImplementation(async (key: string) => {
    const raw = await originalGet(key);
    await blocked;
    return raw;
  });
  return { release, restore: () => spy.mockRestore() };
}

describe('createRedisCallOfferBuffer', () => {
  it('drains a buffered offer', async () => {
    const redis = makeMockRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await settle();
    const out = await buf.drain('bob');
    expect(out).toEqual([OFFER]);
  });

  it('preserves offer + ICE ordering across instances', async () => {
    const redis = makeMockRedis();
    // First instance puts offer + ICE; second instance drains.
    const writer = createRedisCallOfferBuffer(redis);
    const reader = createRedisCallOfferBuffer(redis);
    writer.put('bob', OFFER);
    await settle();
    writer.put('bob', ICE_A);
    await settle();
    writer.put('bob', ICE_B);
    await settle();
    const out = await reader.drain('bob');
    expect(out).toEqual([OFFER, ICE_A, ICE_B]);
  });

  it('ignores ICE whose callId does not match the buffered offer', async () => {
    const redis = makeMockRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await settle();
    buf.put('bob', { ...ICE_A, callId: 'call-999' });
    await settle();
    expect(await buf.drain('bob')).toEqual([OFFER]);
  });

  it('replaces a prior buffered call when a new offer arrives', async () => {
    const redis = makeMockRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await settle();
    buf.put('bob', ICE_A);
    await settle();
    const offer2 = { ...OFFER, callId: 'call-002', ciphertext: 'bmV3' };
    buf.put('bob', offer2);
    await settle();
    expect(await buf.drain('bob')).toEqual([offer2]);
  });

  it('clear() removes only the matching callId', async () => {
    const redis = makeMockRedis();
    const buf = createRedisCallOfferBuffer(redis);
    buf.put('bob', OFFER);
    await settle();
    buf.clear('bob', 'call-999');
    await settle();
    // Mismatched clear is a no-op — the offer still drains.
    expect(await buf.drain('bob')).toEqual([OFFER]);

    // Put again, then a matching clear removes it.
    buf.put('bob', OFFER);
    await settle();
    buf.clear('bob', 'call-001');
    await settle();
    expect(await buf.drain('bob')).toEqual([]);
  });

  it('does not drain a rejected offer while clear is in flight', async () => {
    const clearRedis = makeMockRedis();
    const reconnectRedis = makeMockRedis();
    const clearer = createRedisCallOfferBuffer(clearRedis);
    const reconnecting = createRedisCallOfferBuffer(reconnectRedis);
    clearer.put('bob', OFFER);
    await settle();

    const blockedGet = blockRedisGet(clearRedis);
    clearer.clear('bob', OFFER.callId);
    await settle();
    const drained = await reconnecting.drain('bob');
    blockedGet.release();
    blockedGet.restore();
    await settle();

    expect(drained).toEqual([]);
  });

  it('does not delete a replacement offer while clear is in flight', async () => {
    const clearRedis = makeMockRedis();
    const writerRedis = makeMockRedis();
    const clearer = createRedisCallOfferBuffer(clearRedis);
    const writer = createRedisCallOfferBuffer(writerRedis);
    const replacement = { ...OFFER, callId: 'call-002', ciphertext: 'bmV3' };
    clearer.put('bob', OFFER);
    await settle();

    const blockedGet = blockRedisGet(clearRedis);
    clearer.clear('bob', OFFER.callId);
    await settle();
    writer.put('bob', replacement);
    await settle();
    blockedGet.release();
    blockedGet.restore();
    await settle();

    expect(await writer.drain('bob')).toEqual([replacement]);
  });

  it('drain returns [] when nothing is buffered', async () => {
    const redis = makeMockRedis();
    const buf = createRedisCallOfferBuffer(redis);
    expect(await buf.drain('nobody')).toEqual([]);
  });

  it('cross-instance: writer + reader run on independent buffer wrappers', async () => {
    // This is the rc.52 → rc.53 failure mode: caller's instance
    // buffers, callee reconnects on a different instance and drains.
    // Two RedisMock instances share state in-process — same shape as
    // two ioredis clients pointed at one Upstash.
    const redisA = makeMockRedis();
    const redisB = makeMockRedis();
    const writer = createRedisCallOfferBuffer(redisA);
    const reader = createRedisCallOfferBuffer(redisB);
    writer.put('bob', OFFER);
    await settle();
    writer.put('bob', ICE_A);
    await settle();
    expect(await reader.drain('bob')).toEqual([OFFER, ICE_A]);
    // After drain the writer also sees an empty buffer.
    expect(await writer.drain('bob')).toEqual([]);
  });

  it('drain swallows malformed JSON gracefully', async () => {
    const redis = makeMockRedis();
    // Inject a malformed value directly.
    await redis.set('speakeasy:call-buf:bob', 'not-json{', 'PX', 30_000);
    const buf = createRedisCallOfferBuffer(redis);
    expect(await buf.drain('bob')).toEqual([]);
  });
});
