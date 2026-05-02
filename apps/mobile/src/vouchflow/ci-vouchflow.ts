import type {
  Confidence,
  VerificationContext,
} from '@speakeasy/vouchflow';
import type {
  VouchflowClient,
  VerifyOpts,
  VerifyResult,
  FallbackResult,
  FallbackVerificationResult,
  FallbackReason,
} from './vouchflow';

/**
 * CI-only Vouchflow client for emulator / test environments where
 * hardware attestation is unavailable.
 *
 * Generates a deterministic device token (`dvt_ci_<timestamp>`) that
 * the server-side `CiMockValidator` accepts when `VOUCHFLOW_USE_MOCK=1`
 * is set. Does NOT call the real Vouchflow SDK — no network, no
 * biometrics, no KeyStore. This allows Tier B Maestro flows to
 * complete enrollment on the Android emulator.
 *
 * **Must not be used in production.**
 */
export class CiVouchflowClient implements VouchflowClient {
  private cachedToken: string | null = null;

  async verify(opts: VerifyOpts): Promise<VerifyResult> {
    const deviceToken = await this.ensureEnrolledForTesting();
    return {
      verified: true,
      confidence: (opts.minimumConfidence ?? 'high') as Confidence,
      deviceToken,
      deviceAgeDays: 0,
      networkVerifications: 1,
      firstSeen: new Date().toISOString(),
      context: opts.context as VerificationContext,
      fallbackUsed: false,
      signals: {
        biometricUsed: false,
        attestationVerified: false,
        persistentToken: true,
        crossAppHistory: false,
        anomalyFlags: [],
      },
    };
  }

  async requestFallback(_email: string, _reason?: FallbackReason): Promise<FallbackResult> {
    // CI doesn't need real fallback — just return a fake session
    return {
      fallbackSessionId: 'ci_fallback_session',
      expiresAt: Date.now() + 600_000,
    };
  }

  async submitFallbackOtp(_sessionId: string, _otp: string): Promise<FallbackVerificationResult> {
    const deviceToken = await this.ensureEnrolledForTesting();
    return {
      verified: true,
      confidence: 'medium' as Confidence,
      deviceToken,
      signals: {
        emailMatch: true,
        ipConsistent: true,
        emailDomainAgeDays: 365,
        emailAgeDays: 100,
        anomalyFlags: [],
      },
      fallbackSessionId: 'ci_fallback_session',
    };
  }

  async getCachedDeviceToken(): Promise<string | null> {
    return this.cachedToken;
  }

  async invalidate(): Promise<void> {
    this.cachedToken = null;
  }

  async ensureEnrolledForTesting(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    // Generate a deterministic CI device token that the server-side
    // CiMockValidator (VOUCHFLOW_USE_MOCK=1) will accept.
    this.cachedToken = `dvt_ci_${Date.now()}`;
    return this.cachedToken;
  }
}
