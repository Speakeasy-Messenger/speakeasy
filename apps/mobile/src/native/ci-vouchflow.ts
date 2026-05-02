/**
 * CiVouchflowClient — CI-only Vouchflow client for emulators.
 *
 * Generates deterministic device tokens without requiring biometric
 * hardware or network access to the Vouchflow API. Used for Maestro
 * E2E tests where real attestation is unavailable.
 *
 * The server must be running with the sandbox Vouchflow validator
 * configured to accept device tokens with the `dvt_ci_` prefix.
 */

import type {
  VerifyResult,
  VerifyOpts,
  FallbackResult,
  FallbackVerificationResult,
} from './vouchflow.js';

let counter = 0;

export class CiVouchflowClient {
  async verify(_opts?: VerifyOpts): Promise<VerifyResult> {
    const token = this._nextToken();
    return {
      verified: true,
      confidence: 'high',
      deviceToken: token,
      deviceAgeDays: 0,
      networkVerifications: 0,
      firstSeen: new Date().toISOString(),
      context: 'signup',
      signals: {
        biometricUsed: false,
        attestationVerified: false,
        persistentToken: true,
        crossAppHistory: false,
        anomalyFlags: [],
      },
      fallbackUsed: false,
    };
  }

  async requestFallback(_email: string): Promise<FallbackResult> {
    return {
      fallbackSessionId: `ci-session-${++counter}`,
      // sessionId is string in SDK 2.0.0
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }

  async submitFallbackOtp(
    _sessionId: string,
    _otp: string,
  ): Promise<FallbackVerificationResult> {
    return {
      verified: true,
      confidence: 'medium',
      sessionState: 'completed',
      fallbackSignals: {
        ipConsistent: true,
        disposableEmailDomain: false,
        deviceHasPriorVerifications: false,
        emailDomainAgeDays: null,
        otpAttempts: 1,
        timeToCompleteSeconds: 5,
      },
    };
  }

  async getCachedDeviceToken(): Promise<string | null> {
    if (counter > 0) return this._nextToken();
    return null;
  }

  async ensureEnrolledForTesting(): Promise<string> {
    return this._nextToken();
  }

  invalidate(): void {
    // no-op
  }

  private _nextToken(): string {
    return `dvt_ci_${Date.now()}_${++counter}`;
  }
}
