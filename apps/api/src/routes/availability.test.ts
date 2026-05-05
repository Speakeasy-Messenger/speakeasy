import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryRateLimiter } from '../ratelimit/ratelimit.js';

function bundle() {
  return {
    registrationId: 1,
    signedPreKeyId: 100,
    signedPreKey: 'sp',
    signedPreKeySig: 'sig',
    preKeys: [{ id: 1, key: 'k1' }],
  };
}

async function makeApp(repo = new InMemoryUserRepo()) {
  return buildServer({
    validator: MockValidator.alwaysSucceeds(),
    userRepo: repo,
    rateLimiter: new InMemoryRateLimiter(),
    logger: false,
  });
}

describe('GET /v1/users/availability', () => {
  it('returns available=true for a fresh handle', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/users/availability?id=alice' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ available: true });
    await app.close();
  });

  it('returns reason=invalid for malformed handles', async () => {
    const app = await makeApp();
    for (const bad of ['ab', '1abc', 'al-ice', 'ALICE!']) {
      const res = await app.inject({
        method: 'GET',
        url: `/v1/users/availability?id=${encodeURIComponent(bad)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.available).toBe(false);
      expect(body.reason).toBe('invalid');
    }
    await app.close();
  });

  it('returns reason=reserved for blocked words', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/users/availability?id=admin' });
    expect(res.json()).toEqual({ available: false, reason: 'reserved' });
    await app.close();
  });

  it('returns reason=taken when the handle is already enrolled', async () => {
    const repo = new InMemoryUserRepo();
    repo.users.set('alice', {
      publicKey: Buffer.from('existing'),
      bundle: bundle(),
      createdAt: new Date(),
      deviceToken: 'dvt_other',
    });
    const app = await makeApp(repo);
    const res = await app.inject({ method: 'GET', url: '/v1/users/availability?id=alice' });
    expect(res.json()).toEqual({ available: false, reason: 'taken' });
    await app.close();
  });

  it('lowercases and trims the input before checking', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: `/v1/users/availability?id=${encodeURIComponent('  Alice  ')}`,
    });
    expect(res.json()).toEqual({ available: true });
    await app.close();
  });

  it('rejects missing id with 400 (schema validation)', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/users/availability' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
