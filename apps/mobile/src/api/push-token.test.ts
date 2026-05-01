import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client.js';

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient.registerPushToken', () => {
  it('POSTs to /v1/devices/push-token and resolves on 200', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      fakeResponse(200, { ok: true }),
    );
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await c.registerPushToken('dvt_test', 'fcm-abc123', 'android');
    const mock = vi.mocked(fetchImpl);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/v1/devices/push-token');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: 'Bearer dvt_test',
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      push_token: 'fcm-abc123',
      platform: 'android',
    });
  });

  it('accepts ios platform', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      fakeResponse(200, { ok: true }),
    );
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await c.registerPushToken('dvt_test', 'apns-xyz', 'ios');
    const body = JSON.parse(vi.mocked(fetchImpl).mock.calls[0]![1]!.body as string);
    expect(body.platform).toBe('ios');
  });

  it('throws ApiError on 401', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(401, { error: 'missing_bearer_token' }),
    );
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await expect(
      c.registerPushToken('bad-token', 'fcm-abc', 'android'),
    ).rejects.toMatchObject({ status: 401, code: 'missing_bearer_token' });
  });

  it('throws ApiError on 400', async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse(400, { error: 'invalid platform' }),
    );
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await expect(
      c.registerPushToken('dvt_test', 'fcm-abc', 'windows' as 'android'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
