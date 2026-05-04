import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';

function bundle() {
  return {
    registrationId: 1,
    signedPreKeyId: 100,
    signedPreKey: Buffer.from('spk').toString('base64'),
    signedPreKeySig: Buffer.from('sig').toString('base64'),
    preKeys: [{ id: 1, key: Buffer.from('k1').toString('base64') }],
  };
}

async function makeApp() {
  const repo = new InMemoryUserRepo();
  await repo.tryCreate({ userId: 'silent-golden-hawk', deviceToken: 'dvt_silent-golden-hawk', publicKey: Buffer.from('hawk-pk'),
    bundle: bundle(),
  });
  const app = await buildServer({
    validator: MockValidator.alwaysSucceeds(),
    userRepo: repo,
    logger: false,
  });
  return { app, repo };
}

describe('GET /v1/users/:id', () => {
  it('returns the user when found', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/silent-golden-hawk',
      headers: { authorization: 'Bearer dvt_demo' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('silent-golden-hawk');
    expect(body.public_key).toBe(Buffer.from('hawk-pk').toString('base64'));
    expect(typeof body.created_at).toBe('string');
    await app.close();
  });

  it('404 when not found', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/ghost-ghost-ghost',
      headers: { authorization: 'Bearer dvt_demo' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('400 on malformed id', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/not_a_valid_id',
      headers: { authorization: 'Bearer dvt_demo' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('401 without bearer', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/silent-golden-hawk',
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
