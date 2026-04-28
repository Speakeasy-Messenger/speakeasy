import type { Confidence } from '@speakeasy/vouchflow';
import type { VerifyOpts, VerifyResult, VouchflowClient } from './vouchflow.js';

/**
 * Test-only client. Returns canned `verify()` results without touching the
 * native SDK. Used by the mobile unit tests and by `services.ts` when
 * `config.useMockVouchflow` is true.
 */
export class MockVouchflowClient implements VouchflowClient {
  constructor(
    private readonly opts: {
      deviceToken?: string;
      confidence?: Confidence;
      verified?: boolean;
      throwOnVerify?: Error;
    } = {},
  ) {}

  async verify(_opts: VerifyOpts): Promise<VerifyResult> {
    if (this.opts.throwOnVerify) {
      throw this.opts.throwOnVerify;
    }
    return {
      verified: this.opts.verified ?? true,
      confidence: this.opts.confidence ?? 'medium',
      deviceToken: this.opts.deviceToken ?? 'dvt_mock',
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
}
