import {
  Validator,
  ValidatedAttestation,
  ValidationFailureReason,
  VouchflowValidationError,
  type Confidence,
} from './types.js';

export type MockResponse =
  | { ok: true; attestation: Partial<ValidatedAttestation> }
  | { ok: false; reason: ValidationFailureReason; message?: string };

export type MockResponder = (deviceToken: string) => Promise<MockResponse> | MockResponse;

/**
 * Test fixture that implements `Validator` without touching the network.
 * Keeps unit tests deterministic — production code never instantiates this
 * outside of `VOUCHFLOW_USE_MOCK=1` mode.
 */
export class MockValidator implements Validator {
  constructor(private readonly responder: MockResponder) {}

  async validate(deviceToken: string): Promise<ValidatedAttestation> {
    const r = await this.responder(deviceToken);
    if (!r.ok) throw new VouchflowValidationError(r.reason, r.message);
    return {
      token: deviceToken,
      deviceToken,
      confidence: 'medium' as Confidence,
      verifiedAt: new Date().toISOString(),
      riskScore: 0,
      anomalyFlags: [],
      lastContext: 'login',
      biometricUsed: true,
      fallbackUsed: false,
      platform: 'ios',
      ...r.attestation,
    };
  }

  // Convenience constructors -------------------------------------------------

  /** Every token validates with the given attestation (default: medium). */
  static alwaysSucceeds(attestation: Partial<ValidatedAttestation> = {}): MockValidator {
    return new MockValidator(() => ({ ok: true, attestation }));
  }

  /** Every token fails with the given reason. */
  static alwaysFailsWith(reason: ValidationFailureReason): MockValidator {
    return new MockValidator(() => ({ ok: false, reason }));
  }

  /** Looks up tokens in a map; unmapped tokens fail with `device_not_found`. */
  static fromMap(table: Record<string, MockResponse>): MockValidator {
    return new MockValidator(
      (t) => table[t] ?? { ok: false, reason: 'device_not_found' },
    );
  }
}
