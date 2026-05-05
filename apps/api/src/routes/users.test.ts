import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';

function makeValidator(): MockValidator {
  // Mirror the WS handler.test.ts pattern so a `dvt_<userId>` bearer
  // attaches the matching userId to `request.auth`. Without this, the
  // PUT-avatar route's `request.auth.userId` is undefined and every
  // request 401s.
  return new MockValidator((tok) => {
    if (tok.startsWith('dvt_')) {
      return { ok: true, attestation: { confidence: 'medium', userId: tok.slice('dvt_'.length) } };
    }
    return { ok: false, reason: 'device_not_found' };
  });
}

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
    validator: makeValidator(),
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
    expect(body.avatar_b64).toBeNull();
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
      // 'AB!' fails both legacy 3-word and new handle formats — uppercase
      // and `!` are disallowed by either regex.
      url: '/v1/users/AB!',
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

describe('PUT /v1/users/me/avatar', () => {
  it('sets the avatar and the next GET reflects it', async () => {
    const { app, repo } = await makeApp();
    const sample = Buffer.from('jpeg-bytes').toString('base64');
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: {
        authorization: 'Bearer dvt_silent-golden-hawk',
        'content-type': 'application/json',
      },
      payload: { avatar_b64: sample },
    });
    expect(put.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: '/v1/users/silent-golden-hawk',
      headers: { authorization: 'Bearer dvt_silent-golden-hawk' },
    });
    expect(get.json().avatar_b64).toBe(sample);

    // Repo state matches what we queried.
    expect((await repo.findById('silent-golden-hawk'))?.avatarB64).toBe(sample);
    await app.close();
  });

  it('clears the avatar when null is sent', async () => {
    const { app, repo } = await makeApp();
    await repo.setAvatar('silent-golden-hawk', 'old-avatar-b64');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: {
        authorization: 'Bearer dvt_silent-golden-hawk',
        'content-type': 'application/json',
      },
      payload: { avatar_b64: null },
    });
    expect(res.statusCode).toBe(204);
    expect((await repo.findById('silent-golden-hawk'))?.avatarB64).toBeUndefined();
    await app.close();
  });

  it('rejects oversized payloads (200KB cap)', async () => {
    const { app } = await makeApp();
    const tooBig = 'A'.repeat(200_001);
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: {
        authorization: 'Bearer dvt_silent-golden-hawk',
        'content-type': 'application/json',
      },
      payload: { avatar_b64: tooBig },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('401 without bearer', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: { 'content-type': 'application/json' },
      payload: { avatar_b64: 'AAA=' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
