import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { CloudflareTurnProvider, StaticTurnProvider } from './turn.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let userRepo: InMemoryUserRepo;

beforeEach(async () => {
  userRepo = new InMemoryUserRepo();
  await userRepo.tryCreate({
    userId: 'alpha',
    deviceToken: 'dvt_alpha',
    publicKey: Buffer.from([0]),
    bundle: {
      registrationId: 1,
      signedPreKeyId: 1,
      signedPreKey: '',
      signedPreKeySig: '',
      preKeys: [],
    },
  });
});

afterEach(async () => {
  if (app) await app.close();
});

describe('GET /v1/turn/credentials', () => {
  it('rejects unauthenticated callers', async () => {
    app = await buildServer({
      validator: new MockValidator((tok) =>
        tok === 'dvt_bad' ? { ok: false, reason: 'device_not_found' } : { ok: false, reason: 'low_confidence' },
      ),
      userRepo,
      turnProvider: new StaticTurnProvider([{ urls: 'stun:stun.l.google.com:19302' }]),
      skipWebsocket: true,
      logger: false,
    });
    const res = await app.inject({ method: 'GET', url: '/v1/turn/credentials' });
    expect(res.statusCode).toBe(401);
  });

  it('returns ICE servers for an authed enrolled user', async () => {
    app = await buildServer({
      validator: new MockValidator(() => ({
        ok: true,
        attestation: { confidence: 'medium' },
        deviceToken: 'dvt_alpha',
      })),
      userRepo,
      turnProvider: new StaticTurnProvider([
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:turn.example.com:3478', username: 'u', credential: 'p' },
      ]),
      skipWebsocket: true,
      logger: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/turn/credentials',
      headers: { authorization: 'Bearer dvt_alpha' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ice_servers: Array<{ urls: string; username?: string }>;
    };
    expect(body.ice_servers).toHaveLength(2);
    expect(body.ice_servers[1]!.username).toBe('u');
  });

  it('surfaces 503 when the provider throws', async () => {
    const failing: import('./turn.js').TurnProvider = {
      async issue() {
        throw new Error('boom');
      },
    };
    app = await buildServer({
      validator: new MockValidator(() => ({
        ok: true,
        attestation: { confidence: 'medium' },
        deviceToken: 'dvt_alpha',
      })),
      userRepo,
      turnProvider: failing,
      skipWebsocket: true,
      logger: false,
    });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/turn/credentials',
      headers: { authorization: 'Bearer dvt_alpha' },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('CloudflareTurnProvider', () => {
  it('posts to the Realtime TURN generate-ice-servers endpoint and returns the array', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      // Mirror the live Cloudflare response shape: an array containing
      // one STUN-only entry (no creds) and one TURN entry with multiple
      // transports + creds.
      return new Response(
        JSON.stringify({
          iceServers: [
            { urls: ['stun:stun.cloudflare.com:3478'] },
            {
              urls: [
                'turn:turn.cloudflare.com:3478?transport=udp',
                'turns:turn.cloudflare.com:443?transport=tcp',
              ],
              username: 'cf-user',
              credential: 'cf-pass',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
    const provider = new CloudflareTurnProvider({
      keyId: 'kid',
      token: 'tok',
      ttlSeconds: 1800,
      fetchImpl: fakeFetch,
    });
    const ice = await provider.issue({ userId: 'alpha' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/keys/kid/credentials/generate-ice-servers');
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.ttl).toBe(1800);
    expect(body.customIdentifier).toBe('alpha');
    expect(ice).toHaveLength(2);
    expect(ice[0]!.urls).toContain('stun:stun.cloudflare.com:3478');
    expect(ice[1]!.username).toBe('cf-user');
    expect(ice[1]!.credential).toBe('cf-pass');
  });
});
