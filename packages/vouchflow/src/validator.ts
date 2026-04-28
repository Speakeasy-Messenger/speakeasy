import type { VouchflowApiClient } from './api-client.js';
import {
  meetsMinimumConfidence,
  Validator,
  ValidatedAttestation,
  VouchflowValidationError,
} from './types.js';

export interface VouchflowValidatorOptions {
  apiClient: VouchflowApiClient;
  /** Max age of `last_verification.completed_at`. Default 5 minutes. */
  maxVerificationAgeMs?: number;
  /** Reject above this. Default 70. Set to 100 to disable. */
  maxRiskScore?: number;
  /**
   * Anomaly flags that hard-reject. Phase 4 hardening — defaults to empty so
   * existing behaviour (surface but allow) is preserved unless opted in.
   * Known flags from spec §4 reputation endpoint: velocity_anomaly,
   * reinstall_anomaly, confidence_degradation.
   */
  hardAnomalyFlags?: readonly string[];
  /** Override clock for tests. */
  now?: () => number;
}

const DEFAULT_MAX_AGE_MS = 5 * 60_000;
const DEFAULT_MAX_RISK = 70;

/**
 * Validates a deviceToken by calling Vouchflow and applying spec §2 gates:
 *   - confidence ≥ medium  (no override)
 *   - last verification within `maxVerificationAgeMs`
 *   - risk_score ≤ `maxRiskScore`
 * Anomaly flags are NOT auto-rejecting in Phase 1 — they're surfaced on
 * the result so the caller can log / act on them. Phase 4 hardening can
 * tighten this.
 */
export class VouchflowValidator implements Validator {
  private readonly maxAgeMs: number;
  private readonly maxRisk: number;
  private readonly hardAnomalyFlags: ReadonlySet<string>;
  private readonly now: () => number;

  constructor(private readonly opts: VouchflowValidatorOptions) {
    this.maxAgeMs = opts.maxVerificationAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.maxRisk = opts.maxRiskScore ?? DEFAULT_MAX_RISK;
    this.hardAnomalyFlags = new Set(opts.hardAnomalyFlags ?? []);
    this.now = opts.now ?? Date.now;
  }

  async validate(deviceToken: string): Promise<ValidatedAttestation> {
    const rep = await this.opts.apiClient.getDeviceReputation(deviceToken);

    if (!rep.last_verification) {
      throw new VouchflowValidationError('no_verification');
    }

    const lv = rep.last_verification;

    if (!meetsMinimumConfidence(lv.confidence)) {
      throw new VouchflowValidationError('low_confidence');
    }

    const verifiedAtMs = Date.parse(lv.completed_at);
    if (Number.isNaN(verifiedAtMs)) {
      throw new VouchflowValidationError('malformed', 'unparseable completed_at');
    }
    if (this.now() - verifiedAtMs > this.maxAgeMs) {
      throw new VouchflowValidationError('stale_verification');
    }

    if (rep.risk_score > this.maxRisk) {
      throw new VouchflowValidationError('high_risk');
    }

    // Phase 4 hardening: reject when any configured "hard" anomaly flag is
    // present. Defaults to empty so the existing surface-but-allow behaviour
    // is preserved unless an operator opts in.
    if (this.hardAnomalyFlags.size > 0) {
      for (const flag of rep.anomaly_flags) {
        if (this.hardAnomalyFlags.has(flag)) {
          throw new VouchflowValidationError('anomaly_rejected', `flag=${flag}`);
        }
      }
    }

    return {
      token: deviceToken,
      deviceToken: rep.device_token,
      confidence: lv.confidence,
      verifiedAt: lv.completed_at,
      riskScore: rep.risk_score,
      anomalyFlags: rep.anomaly_flags,
      lastContext: lv.context,
      biometricUsed: lv.biometric_used,
      fallbackUsed: lv.fallback_used,
      platform: rep.platform,
    };
  }
}
