import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from './ratelimit.js';

describe('InMemoryRateLimiter', () => {
  it('allows up to limit then rejects', async () => {
    const r = new InMemoryRateLimiter();
    const args = { subject: 's', endpoint: 'e', limit: 3, windowMs: 1000, now: 1000 };
    expect((await r.consume(args)).allowed).toBe(true);
    expect((await r.consume(args)).allowed).toBe(true);
    expect((await r.consume(args)).allowed).toBe(true);
    expect((await r.consume(args)).allowed).toBe(false);
  });

  it('decrements remaining', async () => {
    const r = new InMemoryRateLimiter();
    const a1 = await r.consume({ subject: 's', endpoint: 'e', limit: 3, windowMs: 1000, now: 1000 });
    const a2 = await r.consume({ subject: 's', endpoint: 'e', limit: 3, windowMs: 1000, now: 1000 });
    expect(a1.remaining).toBe(2);
    expect(a2.remaining).toBe(1);
  });

  it('rolls over to a new window', async () => {
    const r = new InMemoryRateLimiter();
    await r.consume({ subject: 's', endpoint: 'e', limit: 1, windowMs: 1000, now: 1000 });
    expect(
      (await r.consume({ subject: 's', endpoint: 'e', limit: 1, windowMs: 1000, now: 1500 })).allowed,
    ).toBe(false);
    expect(
      (await r.consume({ subject: 's', endpoint: 'e', limit: 1, windowMs: 1000, now: 2001 })).allowed,
    ).toBe(true);
  });

  it('isolates by (subject, endpoint)', async () => {
    const r = new InMemoryRateLimiter();
    await r.consume({ subject: 'a', endpoint: 'e', limit: 1, windowMs: 1000, now: 1000 });
    expect(
      (await r.consume({ subject: 'b', endpoint: 'e', limit: 1, windowMs: 1000, now: 1000 })).allowed,
    ).toBe(true);
    expect(
      (await r.consume({ subject: 'a', endpoint: 'e2', limit: 1, windowMs: 1000, now: 1000 })).allowed,
    ).toBe(true);
  });

  it('exposes resetAtMs as the next-bucket boundary', async () => {
    const r = new InMemoryRateLimiter();
    const d = await r.consume({ subject: 's', endpoint: 'e', limit: 5, windowMs: 1000, now: 1234 });
    expect(d.resetAtMs).toBe(2000);
  });
});
