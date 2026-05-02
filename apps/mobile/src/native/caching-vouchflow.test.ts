import { describe, expect, it, vi } from 'vitest';
import { CachingVouchflowClient } from './caching-vouchflow.js';
import type { VouchflowClient, VerifyResult } from './vouchflow.js';

/**
 * Minimal stub VouchflowClient for testing CachingVouchflowClient.
 * Replaces MockVouchflowClient which was removed in the SDK 2.0.0 integration.
 */
class StubVouchflowClient implements VouchflowClient {
  constructor(private readonly opts: { deviceToken?: string } = {}) {}

  async verify(): Promise<VerifyResult> {
    return {
      verified: true,
      confidence: 'medium',
      deviceToken: this.opts.deviceToken ?? 'dvt_stub',
      deviceAgeDays: 1,
      networkVerifications: 5,
      firstSeen: '2026-01-01T00:00:00Z',
      context: 'login',
      fallbackUsed: false,
      signals: {
        biometricUsed: true,
        attestationVerified: true,
        persistentToken: true,
        crossAppHistory: false,
        anomalyFlags: [],
      },
    };
  }

  async getCachedDeviceToken(): Promise<string | null> {
    return 'dvt_stub';
  }

  async requestFallback(): Promise<never> {
    throw new Error('not implemented in stub');
  }

  async submitFallbackOtp(): Promise<never> {
    throw new Error('not implemented in stub');
  }

  async ensureEnrolledForTesting(): Promise<string> {
    return 'dvt_stub';
  }
}

describe('CachingVouchflowClient', () => {
  it('returns the cached deviceToken within the freshness window', async () => {
    let now = 1_000;
    const inner = new StubVouchflowClient({ deviceToken: 'dvt_abc' });
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
    const inner = new StubVouchflowClient({ deviceToken: 'dvt_abc' });
    const verifySpy = vi.spyOn(inner, 'verify');
    const c = new CachingVouchflowClient(inner, { maxAgeMs: 60_000, now: () => now });

    await c.verify({ context: 'login' });
    now += 60_001;
    await c.verify({ context: 'login' });
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it('invalidate() clears the cache', async () => {
    const inner = new StubVouchflowClient({ deviceToken: 'dvt_abc' });
    const verifySpy = vi.spyOn(inner, 'verify');
    const c = new CachingVouchflowClient(inner);
    await c.verify({ context: 'login' });
    c.invalidate();
    await c.verify({ context: 'login' });
    expect(verifySpy).toHaveBeenCalledTimes(2);
  });

  it('different verify opts share the cache (deviceToken is what matters)', async () => {
    const inner = new StubVouchflowClient({ deviceToken: 'dvt_abc' });
    const verifySpy = vi.spyOn(inner, 'verify');
    const c = new CachingVouchflowClient(inner, { maxAgeMs: 60_000 });
    await c.verify({ context: 'login' });
    await c.verify({ context: 'sensitive_action', minimumConfidence: 'high' });
    expect(verifySpy).toHaveBeenCalledTimes(1);
  });
});
