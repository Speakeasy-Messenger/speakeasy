import type { VerifyOpts, VerifyResult, VouchflowClient } from './vouchflow.js';

/**
 * Wrapper that caches the most recent `verify()` result so back-to-back
 * calls (typical on WS reconnect storms) don't trigger a fresh biometric
 * prompt every time. Cache lifetime must stay strictly below the server's
 * `VOUCHFLOW_MAX_VERIFICATION_AGE_MS` (default 5 min — see Vouchflow
 * `VouchflowValidator`) so the cached deviceToken never expires server-side
 * before the cache does.
 *
 * Default: 4 minutes — leaves a 1-minute safety margin against the server's
 * 5-minute freshness window.
 */
export class CachingVouchflowClient implements VouchflowClient {
  private cached?: { result: VerifyResult; expiresAt: number };

  constructor(
    private readonly inner: VouchflowClient,
    private readonly opts: { maxAgeMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async verify(opts: VerifyOpts): Promise<VerifyResult> {
    if (this.cached && this.now() < this.cached.expiresAt) {
      return this.cached.result;
    }
    const result = await this.inner.verify(opts);
    const ttl = this.opts.maxAgeMs ?? 4 * 60_000;
    this.cached = { result, expiresAt: this.now() + ttl };
    return result;
  }

  /** Drop the cached deviceToken — call after suspected rotation / sign-out. */
  invalidate(): void {
    this.cached = undefined;
  }
}
