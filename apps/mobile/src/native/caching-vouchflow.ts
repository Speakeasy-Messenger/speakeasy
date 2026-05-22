import type {
  VerifyOpts,
  VerifyResult,
  VouchflowClient,
  FallbackResult,
  FallbackVerificationResult,
  FallbackReason,
} from './vouchflow.js';

/**
 * Wrapper that caches the most recent `verify()` result so back-to-back
 * calls (typical on WS reconnect storms) don't trigger a fresh biometric
 * prompt every time. Cache lifetime must stay strictly below the server's
 * `VOUCHFLOW_MAX_VERIFICATION_AGE_MS` on the server should be configured
 * to accept this window. The client cache is intentionally long so normal
 * reconnects and foreground/background cycles do not re-open the biometric
 * sheet every few minutes.
 *
 * Default: 30 days.
 *
 * `requestFallback` and `submitFallbackOtp` are passed through directly —
 * they are not cached because they represent one-time server interactions.
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
    const ttl = this.opts.maxAgeMs ?? 30 * 24 * 60 * 60_000;
    this.cached = { result, expiresAt: this.now() + ttl };
    return result;
  }

  async requestFallback(email: string, reason?: FallbackReason): Promise<FallbackResult> {
    return this.inner.requestFallback(email, reason);
  }

  async submitFallbackOtp(sessionId: string, otp: string): Promise<FallbackVerificationResult> {
    return this.inner.submitFallbackOtp(sessionId, otp);
  }

  async getCachedDeviceToken(): Promise<string | null> {
    return this.inner.getCachedDeviceToken();
  }

  /** Drop the cached deviceToken — call after suspected rotation / sign-out. */
  invalidate(): void {
    this.cached = undefined;
  }
}
