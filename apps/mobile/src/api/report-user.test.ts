import { describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError } from './client.js';

function makeClient(mockFetch: typeof fetch): ApiClient {
  return new ApiClient({ baseUrl: 'https://api.example.test', fetchImpl: mockFetch });
}

function jsonResponse(status: number, body: object): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ApiClient.reportUser', () => {
  it('posts the reason + detail and forwards the recorded/banned flags', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, recorded: true, banned: false }),
    ) as unknown as typeof fetch;
    const api = makeClient(fetchMock);

    const result = await api.reportUser(
      'quiet_fox',
      { reason: 'harassment', detail: 'kept DMing after I asked them to stop' },
      'dvt_my-token',
    );

    expect(result).toEqual({ recorded: true, banned: false });
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://api.example.test/v1/users/quiet_fox/report');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers.authorization).toBe('Bearer dvt_my-token');
    const body = JSON.parse(call[1].body as string);
    expect(body).toEqual({ reason: 'harassment', detail: 'kept DMing after I asked them to stop' });
  });

  it('URL-encodes the handle so a paste with a leading `@` or weird chars still resolves', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, recorded: true, banned: false }),
    ) as unknown as typeof fetch;
    const api = makeClient(fetchMock);
    await api.reportUser('weird name', { reason: 'spam' }, 'dvt_t');
    const call = (fetchMock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0]).toBe('https://api.example.test/v1/users/weird%20name/report');
  });

  it('throws ApiError with the server error code on 400 self-report', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { error: 'self_report' }),
    ) as unknown as typeof fetch;
    const api = makeClient(fetchMock);
    await expect(
      api.reportUser('myself', { reason: 'spam' }, 'dvt_myself'),
    ).rejects.toMatchObject({ name: 'ApiError', status: 400, code: 'self_report' });
  });

  it('throws ApiError on 404 (unknown handle)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(404, { error: 'user_not_found' }),
    ) as unknown as typeof fetch;
    const api = makeClient(fetchMock);
    await expect(
      api.reportUser('ghost', { reason: 'spam' }, 'dvt_t'),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('throws ApiError on 429 rate-limit', async () => {
    const fetchMock = vi.fn(async () =>
      new Response('Too Many Requests', { status: 429 }),
    ) as unknown as typeof fetch;
    const api = makeClient(fetchMock);
    // Body parses as non-JSON; the client falls through to a code-less ApiError.
    await expect(
      api.reportUser('peer', { reason: 'spam' }, 'dvt_t'),
    ).rejects.toMatchObject({ name: 'ApiError', status: 429 });
  });

  it('passes the banned flag through when the report triggered an auto-ban', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, recorded: true, banned: true }),
    ) as unknown as typeof fetch;
    const api = makeClient(fetchMock);
    const result = await api.reportUser('peer', { reason: 'threats' }, 'dvt_t');
    expect(result.banned).toBe(true);
  });

  it('marks recorded:false when the server saw a duplicate', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { ok: true, recorded: false, banned: false }),
    ) as unknown as typeof fetch;
    const api = makeClient(fetchMock);
    const result = await api.reportUser('peer', { reason: 'spam' }, 'dvt_t');
    expect(result.recorded).toBe(false);
  });
});
