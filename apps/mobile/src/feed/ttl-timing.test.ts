import { describe, expect, it } from 'vitest';
import { TTL_OPTIONS } from '@speakeasy/shared';
import {
  dissolveDelayMs,
  ttlAnchorMs,
  MAX_TIMEOUT_MS,
  DISSOLVE_TAIL_MS,
} from './ttl-timing.js';

const ms = (ttl: keyof typeof TTL_OPTIONS) => (TTL_OPTIONS[ttl] ?? 0) * 1000;

describe('dissolveDelayMs', () => {
  it('a FRESH month-TTL message does not schedule an immediate (or negative) remove', () => {
    // Regression: month = 2_592_000_000 ms > INT32_MAX. Pre-fix the raw
    // ttlMs - elapsedMs was passed to setTimeout, wrapped negative under
    // Hermes, fired next-tick, and the remove() tail wiped the whole chat
    // ~1.6s after open. The cap must keep the full cascade within INT32.
    const delay = dissolveDelayMs(ms('month'), 0);
    expect(delay).toBeGreaterThan(0);
    expect(delay + DISSOLVE_TAIL_MS).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    // And specifically not insta-fire.
    expect(delay).toBeGreaterThan(60_000);
  });

  it('keeps the entire dissolve cascade within INT32 for every TTL option', () => {
    for (const ttl of Object.keys(TTL_OPTIONS) as (keyof typeof TTL_OPTIONS)[]) {
      if (TTL_OPTIONS[ttl] === null) continue; // 'off' — engine returns early
      for (const elapsed of [0, 1_000, ms('day'), ms('week'), ms('month') + 1]) {
        const delay = dissolveDelayMs(ms(ttl), elapsed);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay + DISSOLVE_TAIL_MS).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
      }
    }
  });

  it('an already-expired message dissolves immediately (correct disappearing behavior)', () => {
    // week TTL, message 8 days old → past TTL → dissolve now.
    expect(dissolveDelayMs(ms('week'), ms('week') + ms('day'))).toBe(0);
  });

  it('a fresh week-TTL message schedules its dissolve a week out (unchanged)', () => {
    // week is under INT32, so it must pass through untouched.
    expect(dissolveDelayMs(ms('week'), 0)).toBe(ms('week'));
  });

  it('the raw (pre-fix) computation really would have overflowed int32 for month', () => {
    // Proves the bug this guards against: the naive delay wraps negative as int32.
    const raw = ms('month'); // 2_592_000_000
    expect(raw).toBeGreaterThan(MAX_TIMEOUT_MS);
    expect(raw | 0).toBeLessThan(0); // int32 cast wraps negative → fires immediately
  });
});

describe('ttlAnchorMs', () => {
  it('prefers receivedAt (when the device saw the message) over sentAt', () => {
    expect(ttlAnchorMs({ sentAt: 1_000, receivedAt: 9_000 })).toBe(9_000);
  });

  it('falls back to sentAt for messages persisted before receivedAt existed', () => {
    expect(ttlAnchorMs({ sentAt: 1_000 })).toBe(1_000);
  });

  it('a recently-RECEIVED but long-ago-SENT message is NOT treated as expired', () => {
    // The regression: offline-buffered backlog arrives with an old sentAt.
    // Anchoring on sentAt would compute a negative remaining TTL (insta-purge);
    // anchoring on receivedAt gives it a fresh, near-full lifetime.
    const now = 10_000_000_000;
    const weekMs = ms('week');
    const m = { sentAt: now - weekMs * 2, receivedAt: now - 1_000 }; // sent 2wk ago, got it 1s ago
    const delay = dissolveDelayMs(weekMs, now - ttlAnchorMs(m));
    expect(delay).toBeGreaterThan(weekMs - 60_000); // ~a full week left
  });
});
