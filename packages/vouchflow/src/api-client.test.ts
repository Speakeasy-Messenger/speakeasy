import { describe, expect, it, vi } from 'vitest';
import { VouchflowApiClient } from './api-client.js';
import { VouchflowValidationError, type DeviceReputation } from './types.js';

const READ_KEY = 'vsk_sandbox_read_test';
const BASE = 'https://sandbox.api.vouchflow.dev/v1';

function reputationOk(): DeviceReputation {
  return {
    device_token: 'dvt_x',
    first_seen: '2026-01-01T00:00:00Z',
    last_seen: '2026-04-25T16:00:00Z',
    total_verifications: 12,
    network_verifications: 7,
    anomaly_flags: [],
    risk_score: 0,
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
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('VouchflowApiClient', () => {
  it('GETs /device/{token}/reputation with bearer + version headers', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(200, reputationOk()));
    const c = new VouchflowApiClient({ baseUrl: BASE, readKey: READ_KEY, fetchImpl });
    const out = await c.getDeviceReputation('dvt_x');
    expect(out.device_token).toBe('dvt_x');
    expect(out.last_verification?.confidence).toBe('high');
    const mock = vi.mocked(fetchImpl);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/device/dvt_x/reputation`);
    expect(init?.method).toBe('GET');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${READ_KEY}`);
    expect(headers['Vouchflow-API-Version']).toBe('2026-04-01');
  });

  it('url-encodes the deviceToken', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(200, reputationOk()));
    const c = new VouchflowApiClient({ baseUrl: BASE, readKey: READ_KEY, fetchImpl });
    await c.getDeviceReputation('dvt with/slash');
    const mock = vi.mocked(fetchImpl);
    const [url] = mock.mock.calls[0]!;
    expect(url).toBe(`${BASE}/device/dvt%20with%2Fslash/reputation`);
  });

  it('strips trailing slashes from baseUrl', () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(200, reputationOk()));
    const c = new VouchflowApiClient({
      baseUrl: 'https://x.example/v1/',
      readKey: READ_KEY,
      fetchImpl,
    });
    void c.getDeviceReputation('dvt_x');
    const mock = vi.mocked(fetchImpl);
    expect(mock.mock.calls[0]![0]).toBe('https://x.example/v1/device/dvt_x/reputation');
  });

  it('maps 404 → device_not_found', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(404, { error: 'nope' }));
    const c = new VouchflowApiClient({ baseUrl: BASE, readKey: READ_KEY, fetchImpl });
    await expect(c.getDeviceReputation('dvt_x')).rejects.toMatchObject({
      reason: 'device_not_found',
    });
  });

  it('maps 403 → forbidden, 401 → unauthorized, 429 → rate_limited', async () => {
    for (const [status, reason] of [
      [403, 'forbidden'],
      [401, 'unauthorized'],
      [429, 'rate_limited'],
    ] as const) {
      const fetchImpl: typeof fetch = vi.fn(async () => jsonResponse(status, {}));
      const c = new VouchflowApiClient({ baseUrl: BASE, readKey: READ_KEY, fetchImpl });
      await expect(c.getDeviceReputation('dvt_x')).rejects.toMatchObject({ reason });
    }
  });

  it('maps fetch failure → network_error', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => {
      throw new Error('connection refused');
    });
    const c = new VouchflowApiClient({ baseUrl: BASE, readKey: READ_KEY, fetchImpl });
    await expect(c.getDeviceReputation('dvt_x')).rejects.toMatchObject({
      reason: 'network_error',
    });
  });

  it('rejects empty deviceToken before hitting the network', async () => {
    const fetchImpl: typeof fetch = vi.fn();
    const c = new VouchflowApiClient({ baseUrl: BASE, readKey: READ_KEY, fetchImpl });
    await expect(c.getDeviceReputation('')).rejects.toBeInstanceOf(VouchflowValidationError);
    expect(vi.mocked(fetchImpl)).not.toHaveBeenCalled();
  });

  it('throws on missing baseUrl or readKey', () => {
    expect(() => new VouchflowApiClient({ baseUrl: '', readKey: 'k' })).toThrow();
    expect(() => new VouchflowApiClient({ baseUrl: 'x', readKey: '' })).toThrow();
  });
});
