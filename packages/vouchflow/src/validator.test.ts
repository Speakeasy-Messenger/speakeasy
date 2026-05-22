import { describe, expect, it, vi } from 'vitest';
import type { VouchflowApiClient } from './api-client.js';
import { VouchflowValidator } from './validator.js';
import {
  VouchflowValidationError,
  type Confidence,
  type DeviceReputation,
} from './types.js';

function rep(overrides: Partial<DeviceReputation> = {}): DeviceReputation {
  const base: DeviceReputation = {
    device_token: 'dvt_x',
    first_seen: '2026-01-01T00:00:00Z',
    last_seen: '2026-04-25T16:00:00Z',
    total_verifications: 12,
    network_verifications: 7,
    anomaly_flags: [],
    risk_score: 5,
    device_age_days: 114,
    platform: 'ios',
    keychain_persistent: true,
    network_participant: false,
    last_verification: {
      confidence: 'high',
      context: 'login',
      completed_at: '2026-04-25T16:00:00Z',
      biometric_used: true,
      fallback_used: false,
    },
  };
  return { ...base, ...overrides };
}

function fakeClient(reputation: DeviceReputation | Error): VouchflowApiClient {
  return {
    getDeviceReputation: vi.fn(async () => {
      if (reputation instanceof Error) throw reputation;
      return reputation;
    }),
  } as unknown as VouchflowApiClient;
}

const NOW = Date.parse('2026-04-25T16:00:30Z');

describe('VouchflowValidator', () => {
  it('returns a populated attestation on success', async () => {
    const v = new VouchflowValidator({ apiClient: fakeClient(rep()), now: () => NOW });
    const out = await v.validate('dvt_x');
    expect(out.deviceToken).toBe('dvt_x');
    expect(out.confidence).toBe('high');
    expect(out.riskScore).toBe(5);
    expect(out.platform).toBe('ios');
    expect(out.biometricUsed).toBe(true);
  });

  it('rejects when there is no last verification', async () => {
    const v = new VouchflowValidator({
      apiClient: fakeClient(rep({ last_verification: null })),
      now: () => NOW,
    });
    await expect(v.validate('dvt_x')).rejects.toMatchObject({ reason: 'no_verification' });
  });

  it('rejects low confidence (no override)', async () => {
    for (const c of ['low'] as Confidence[]) {
      const r = rep();
      r.last_verification!.confidence = c;
      const v = new VouchflowValidator({ apiClient: fakeClient(r), now: () => NOW });
      await expect(v.validate('dvt_x')).rejects.toMatchObject({ reason: 'low_confidence' });
    }
  });

  it('accepts medium and high confidence', async () => {
    for (const c of ['medium', 'high'] as Confidence[]) {
      const r = rep();
      r.last_verification!.confidence = c;
      const v = new VouchflowValidator({ apiClient: fakeClient(r), now: () => NOW });
      const out = await v.validate('dvt_x');
      expect(out.confidence).toBe(c);
    }
  });

  it('rejects stale verifications past the freshness window', async () => {
    const r = rep();
    r.last_verification!.completed_at = '2026-04-25T15:50:00Z'; // 10 minutes old
    const v = new VouchflowValidator({
      apiClient: fakeClient(r),
      maxVerificationAgeMs: 5 * 60_000,
      now: () => NOW,
    });
    await expect(v.validate('dvt_x')).rejects.toMatchObject({ reason: 'stale_verification' });
  });

  it('accepts month-old verifications by default', async () => {
    const r = rep();
    r.last_verification!.completed_at = '2026-03-27T16:00:00Z'; // 29 days old
    const v = new VouchflowValidator({
      apiClient: fakeClient(r),
      now: () => NOW,
    });

    await expect(v.validate('dvt_x')).resolves.toMatchObject({ deviceToken: 'dvt_x' });
  });

  it('rejects verifications older than the default month window', async () => {
    const r = rep();
    r.last_verification!.completed_at = '2026-03-25T16:00:00Z'; // 31 days old
    const v = new VouchflowValidator({
      apiClient: fakeClient(r),
      now: () => NOW,
    });

    await expect(v.validate('dvt_x')).rejects.toMatchObject({ reason: 'stale_verification' });
  });

  it('rejects high risk_score', async () => {
    const v = new VouchflowValidator({
      apiClient: fakeClient(rep({ risk_score: 90 })),
      maxRiskScore: 70,
      now: () => NOW,
    });
    await expect(v.validate('dvt_x')).rejects.toMatchObject({ reason: 'high_risk' });
  });

  it('does not auto-reject on anomaly_flags by default (surface-but-allow)', async () => {
    const v = new VouchflowValidator({
      apiClient: fakeClient(rep({ anomaly_flags: ['velocity_anomaly'] })),
      now: () => NOW,
    });
    const out = await v.validate('dvt_x');
    expect(out.anomalyFlags).toEqual(['velocity_anomaly']);
  });

  it('Phase 4: hardAnomalyFlags rejects when a configured flag is present', async () => {
    const v = new VouchflowValidator({
      apiClient: fakeClient(rep({ anomaly_flags: ['reinstall_anomaly'] })),
      hardAnomalyFlags: ['reinstall_anomaly', 'attestation_downgrade'],
      now: () => NOW,
    });
    await expect(v.validate('dvt_x')).rejects.toMatchObject({ reason: 'anomaly_rejected' });
  });

  it('Phase 4: hardAnomalyFlags ignores flags not in the configured set', async () => {
    const v = new VouchflowValidator({
      apiClient: fakeClient(rep({ anomaly_flags: ['velocity_anomaly'] })),
      hardAnomalyFlags: ['reinstall_anomaly'],
      now: () => NOW,
    });
    const out = await v.validate('dvt_x');
    expect(out.anomalyFlags).toEqual(['velocity_anomaly']);
  });

  it('propagates api-client errors as-is', async () => {
    const v = new VouchflowValidator({
      apiClient: fakeClient(new VouchflowValidationError('device_not_found')),
      now: () => NOW,
    });
    await expect(v.validate('dvt_x')).rejects.toMatchObject({ reason: 'device_not_found' });
  });
});
