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
 * Calls `ensureEnrolledForTesting()` to get a device token without
 * biometric verification, then returns mock results for all other
 * methods. This allows Tier B Maestro flows to complete enrollment
 * on the Android emulator.
 *
 * **Must not be used in production.**
 */
export class CiVouchflowClient implements VouchflowClient {
  private cachedToken: string | null = null;

  async verify(opts: VerifyOpts): Promise<VerifyResult> {
    // On CI, use ensureEnrolledForTesting instead of real biometric flow
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
    throw new Error('CiVouchflowClient: requestFallback not available in CI');
  }

  async submitFallbackOtp(_sessionId: string, _otp: string): Promise<FallbackVerificationResult> {
    throw new Error('CiVouchflowClient: submitFallbackOtp not available in CI');
  }

  async getCachedDeviceToken(): Promise<string | null> {
    return this.cachedToken;
  }

  async invalidate(): Promise<void> {
    this.cachedToken = null;
  }

  async ensureEnrolledForTesting(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    const { NativeVouchflowClient } = await import('./vouchflow');
    const native = new NativeVouchflowClient();
    this.cachedToken = await native.ensureEnrolledForTesting();
    return this.cachedToken;
  }
}
