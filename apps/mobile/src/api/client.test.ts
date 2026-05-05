import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client.js';

function bundle() {
  return {
    registrationId: 1,
    signedPreKeyId: 100,
    signedPreKey: 'AAA=',
    signedPreKeySig: 'BBB=',
    preKeys: [{ id: 1, key: 'CCC=' }],
  };
}

function fakeResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient.enroll', () => {
  it('POSTs to /v1/enroll and returns user_id on 201', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      fakeResponse(201, { user_id: 'alice' }),
    );
    const c = new ApiClient({ baseUrl: 'https://api.example.test/', fetchImpl });
    const out = await c.enroll({
      token: 't',
      user_id: 'alice',
      publicKey: 'pk',
      preKeyBundle: bundle(),
    });
    expect(out.user_id).toBe('alice');
    const mock = vi.mocked(fetchImpl);
    expect(mock).toHaveBeenCalledTimes(1);
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/v1/enroll');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual({
      token: 't',
      user_id: 'alice',
      publicKey: 'pk',
      preKeyBundle: bundle(),
    });
  });

  it('throws ApiError with code on 401', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(401, { error: 'low_confidence' }));
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await expect(
      c.enroll({ token: 't', user_id: 'alice', publicKey: 'pk', preKeyBundle: bundle() }),
    ).rejects.toMatchObject({ status: 401, code: 'low_confidence' });
  });

  it('throws ApiError without code on opaque 5xx', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 500 }));
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    const err = await c
      .enroll({ token: 't', user_id: 'alice', publicKey: 'pk', preKeyBundle: bundle() })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
  });

  it('exposes 409 taken so onboarding can prompt for another handle', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse(409, { error: 'taken' }));
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await expect(
      c.enroll({ token: 't', user_id: 'alice', publicKey: 'pk', preKeyBundle: bundle() }),
    ).rejects.toMatchObject({ status: 409, code: 'taken' });
  });
});

describe('ApiClient.checkAvailability', () => {
  it('returns available=true for a fresh handle', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => fakeResponse(200, { available: true }));
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    const r = await c.checkAvailability('alice');
    expect(r).toEqual({ available: true });
    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe('https://api.example.test/v1/users/availability?id=alice');
  });

  it('forwards reason on availability=false', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () =>
      fakeResponse(200, { available: false, reason: 'taken' }),
    );
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    const r = await c.checkAvailability('alice');
    expect(r).toEqual({ available: false, reason: 'taken' });
  });

  it('url-encodes the handle', async () => {
    const fetchImpl: typeof fetch = vi.fn(async () => fakeResponse(200, { available: true }));
    const c = new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl });
    await c.checkAvailability('foo bar');
    const [url] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe('https://api.example.test/v1/users/availability?id=foo%20bar');
  });
});
