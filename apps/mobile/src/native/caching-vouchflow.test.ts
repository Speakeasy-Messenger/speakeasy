import { describe, expect, it, vi } from 'vitest';
import { MockVouchflowClient } from './mock-vouchflow.js';
import { CachingVouchflowClient } from './caching-vouchflow.js';

describe('CachingVouchflowClient', () => {
  it('returns the cached deviceToken within the freshness window', async () => {
    let now = 1_000;
    const inner = new MockVouchflowClient({ deviceToken: 'dvt_abc' });
    const verifySpy = vi.spyOn(inner, 'verify');
    const c = new CachingVouchflowClient(inner, { maxAgeMs: 60_000, now: () => now });

    const r1 = await c.verify({ context: 'login' });
    expect(r1.deviceToken).toBe('dvt_abc');
    expect(verifySpy).toHaveBeenCalledTimes(1);

    now += 30_000;
    const r2 = await c.verify({ context: 'login' });
    expect(r2.deviceToken).toBe('dvt_abc');
    expect(verifySpy).toHaveBeenCalledTimes(1); // cache hit
  });

  it('re-verifies after the freshness window expires', async () => {
    let now = 1_000;
    const inner = new MockVouchflowClient({ deviceToken: 'dvt_abc' });
    const verifySpy = vi.spyOn(inner, 'verify');
    const c = new CachingVouchflowClient(inner, { maxAgeMs: 60_000, now: () => now });

    await c.verify({ context: 'login' });
    now += 60_001;
    await c.verify({ context: 'login' });
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it('invalidate() clears the cache', async () => {
    const inner = new MockVouchflowClient({ deviceToken: 'dvt_abc' });
    const verifySpy = vi.spyOn(inner, 'verify');
    const c = new CachingVouchflowClient(inner);
    await c.verify({ context: 'login' });
    c.invalidate();
    await c.verify({ context: 'login' });
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it('different verify opts share the cache (deviceToken is what matters)', async () => {
    const inner = new MockVouchflowClient({ deviceToken: 'dvt_abc' });
    const verifySpy = vi.spyOn(inner, 'verify');
    const c = new CachingVouchflowClient(inner, { maxAgeMs: 60_000 });
    await c.verify({ context: 'login' });
    await c.verify({ context: 'sensitive_action', minimumConfidence: 'high' });
    // Phase 5b note: caching across contexts is acceptable because the
    // server's freshness check looks at last_verification.completed_at, not
    // the specific context. If we ever need per-context caching, partition
    // the cache key by `opts.context`.
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });
});
