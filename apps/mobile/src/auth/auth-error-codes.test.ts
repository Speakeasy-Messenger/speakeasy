import { describe, expect, it } from 'vitest';
import { isTransientAuthFailure } from './auth-error-codes.js';

describe('isTransientAuthFailure', () => {
  it('treats auth-infra codes as transient (do NOT re-attest)', () => {
    expect(isTransientAuthFailure('network_error')).toBe(true);
    expect(isTransientAuthFailure('rate_limited')).toBe(true);
  });

  it('treats genuine token/attestation rejections as NOT transient', () => {
    for (const code of [
      'device_not_found',
      'low_confidence',
      'unauthorized',
      'high_risk',
      'anomaly_rejected',
      'stale_verification',
      'no_verification',
      'forbidden',
    ]) {
      expect(isTransientAuthFailure(code)).toBe(false);
    }
  });

  it('fails closed for unknown/absent codes (treated as genuine)', () => {
    expect(isTransientAuthFailure(undefined)).toBe(false);
    expect(isTransientAuthFailure(null)).toBe(false);
    expect(isTransientAuthFailure('')).toBe(false);
    expect(isTransientAuthFailure('some_future_code')).toBe(false);
  });
});
