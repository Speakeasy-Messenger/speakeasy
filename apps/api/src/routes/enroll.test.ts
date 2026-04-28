import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { isUserId } from '@speakeasy/shared';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryRateLimiter } from '../ratelimit/ratelimit.js';

function bundle() {
  return {
    registrationId: 1,
    signedPreKeyId: 100,
    signedPreKey: Buffer.from('signed-prekey').toString('base64'),
    signedPreKeySig: Buffer.from('signed-prekey-sig').toString('base64'),
    preKeys: [
      { id: 1, key: Buffer.from('k1').toString('base64') },
      { id: 2, key: Buffer.from('k2').toString('base64') },
    ],
  };
}

async function makeApp(overrides: Partial<Parameters<typeof buildServer>[0]> = {}) {
  return buildServer({
    validator: MockValidator.alwaysSucceeds(),
    userRepo: new InMemoryUserRepo(),
    logger: false,
    ...overrides,
  });
}

describe('POST /v1/enroll', () => {
  it('creates a user with a valid deviceToken', async () => {
    const repo = new InMemoryUserRepo();
    const app = await makeApp({ userRepo: repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: {
        token: 'dvt_demo_001',
        publicKey: Buffer.from('pk').toString('base64'),
        preKeyBundle: bundle(),
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(isUserId(body.user_id)).toBe(true);
    expect(repo.users.has(body.user_id)).toBe(true);
    await app.close();
  });

  it('rejects low confidence', async () => {
    const app = await makeApp({ validator: MockValidator.alwaysFailsWith('low_confidence') });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: {
        token: 'dvt_low',
        publicKey: Buffer.from('pk').toString('base64'),
        preKeyBundle: bundle(),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('low_confidence');
    await app.close();
  });

  it('rejects unknown device tokens', async () => {
    const app = await makeApp({ validator: MockValidator.alwaysFailsWith('device_not_found') });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: {
        token: 'dvt_bogus',
        publicKey: Buffer.from('pk').toString('base64'),
        preKeyBundle: bundle(),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('device_not_found');
    await app.close();
  });

  it('rejects malformed body', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: { token: 'x' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('retries on id collision and eventually succeeds', async () => {
    const repo = new InMemoryUserRepo();
    repo.users.set('aaa-bbb-ccc', {
      publicKey: Buffer.from('existing'),
      bundle: bundle(),
    });
    let calls = 0;
    const generateId = () => {
      calls++;
      return calls === 1 ? 'aaa-bbb-ccc' : 'fresh-shiny-fish';
    };
    const app = await makeApp({ userRepo: repo, generateId });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: {
        token: 'dvt_collide',
        publicKey: Buffer.from('pk').toString('base64'),
        preKeyBundle: bundle(),
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user_id).toBe('fresh-shiny-fish');
    expect(calls).toBe(2);
    await app.close();
  });

  it('rate-limits enrollment per Phase 4 hardening', async () => {
    const limiter = new InMemoryRateLimiter();
    const app = await makeApp({ rateLimiter: limiter });
    const payload = {
      token: 'dvt_x',
      publicKey: Buffer.from('pk').toString('base64'),
      preKeyBundle: bundle(),
    };
    // Default enroll rate-limit is 5/hour. The 6th hit returns 429.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'POST', url: '/v1/enroll', payload });
      expect(res.statusCode).toBe(201);
    }
    const res = await app.inject({ method: 'POST', url: '/v1/enroll', payload });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('0');
    await app.close();
  });

  it('gives up after sustained collisions', async () => {
    const repo = new InMemoryUserRepo();
    const app = await makeApp({
      userRepo: repo,
      generateId: () => 'always-the-same',
    });
    repo.users.set('always-the-same', {
      publicKey: Buffer.from('x'),
      bundle: bundle(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: {
        token: 'dvt_x',
        publicKey: Buffer.from('pk').toString('base64'),
        preKeyBundle: bundle(),
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('id_generation_failed');
    await app.close();
  });
});
