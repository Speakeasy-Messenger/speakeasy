/**
 * Vouchflow device-attestation contract.
 *
 * The mobile SDK does enrollment + challenge + sign + verify-with-Vouchflow
 * internally and returns a `deviceToken` to the app. The app forwards the
 * deviceToken to your server. Your server validates by calling
 *   GET /v1/device/{deviceToken}/reputation
 * with a read-scoped key, then asserts confidence + freshness + risk-score
 * gates here. There is no shared secret and no JWT — the deviceToken is an
 * opaque handle the Vouchflow API resolves.
 *
 * Confidence levels per spec §2:
 *   low    — new device, no history          (REJECTED)
 *   medium — established device, attestation OK (allowed)
 *   high   — strong history, multi-attestation (allowed)
 *
 * `medium` is the floor. There is no override.
 */

export type Confidence = 'low' | 'medium' | 'high';

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Floor for any authenticated request — spec §2. */
export const MIN_CONFIDENCE: Confidence = 'medium';

export function meetsMinimumConfidence(c: Confidence): boolean {
  return CONFIDENCE_RANK[c] >= CONFIDENCE_RANK[MIN_CONFIDENCE];
}

export type VerificationContext = 'signup' | 'login' | 'sensitive_action';

/** Subset of the `/v1/device/{token}/reputation` response we depend on. */
export interface DeviceReputation {
  device_token: string;
  first_seen: string;
  last_seen: string;
  total_verifications: number;
  network_verifications: number;
  anomaly_flags: string[];
  risk_score: number;
  device_age_days: number;
  platform: 'ios' | 'android';
  keychain_persistent: boolean;
  network_participant: boolean;
  last_verification: {
    confidence: Confidence;
    context: VerificationContext;
    completed_at: string;
    biometric_used: boolean;
    fallback_used: boolean;
  } | null;
}

/** Result of validating a deviceToken — what authenticated handlers see. */
export interface ValidatedAttestation {
  /** The deviceToken that was validated. */
  token: string;
  /** Same as `token`; named for clarity downstream. */
  deviceToken: string;
  confidence: Confidence;
  /** ISO 8601 timestamp of the verification this validation reflects. */
  verifiedAt: string;
  riskScore: number;
  anomalyFlags: string[];
  lastContext: VerificationContext;
  biometricUsed: boolean;
  fallbackUsed: boolean;
  platform: 'ios' | 'android';
  /** Speakeasy user id, set by the app once enrolled. Optional metadata. */
  userId?: string;
}

export type ValidationFailureReason =
  | 'malformed'
  | 'device_not_found'
  | 'forbidden'
  | 'unauthorized'
  | 'rate_limited'
  | 'no_verification'
  | 'low_confidence'
  | 'stale_verification'
  | 'high_risk'
  | 'anomaly_rejected'
  | 'network_error';

export class VouchflowValidationError extends Error {
  constructor(
    public readonly reason: ValidationFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'VouchflowValidationError';
  }
}

export interface Validator {
  /** Throws VouchflowValidationError on any failure (incl. low confidence). */
  validate(deviceToken: string): Promise<ValidatedAttestation>;
}
