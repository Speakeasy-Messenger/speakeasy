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
    // Phase 2 brand overhaul: animal id replaces the JPEG blob field.
    // Null when the user hasn't picked one yet (mobile falls back to a
    // deterministic-from-userId default for rendering).
    expect(body.selected_avatar_id).toBeNull();
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

describe('GET /v1/users/me — fresh-install identity recovery', () => {
  it('returns the user bound to the deviceToken', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      // The mock validator binds dvt_<id> → user_id. Mobile clients
      // hit this endpoint after a fresh install with their persisted
      // Vouchflow deviceToken to recover their previous identity
      // without going through the Handle picker again.
      headers: { authorization: 'Bearer dvt_silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe('silent-golden-hawk');
    expect(body.public_key).toBe(Buffer.from('hawk-pk').toString('base64'));
    expect(body.selected_avatar_id).toBeNull();
    await app.close();
  });

  it('404 when the deviceToken has no user bound', async () => {
    const { app } = await makeApp();
    // dvt_<unknown>: validator says "ok with userId=unknown", but the
    // user repo has no row for that id — same path a stale token
    // would take after the user was removed server-side.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer dvt_no-such-user' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('401 without bearer', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('PUT /v1/users/me/avatar', () => {
  it('sets the selected animal and the next GET reflects it', async () => {
    const { app, repo } = await makeApp();
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: {
        authorization: 'Bearer dvt_silent-golden-hawk',
        'content-type': 'application/json',
      },
      payload: { animal_id: 'fox' },
    });
    expect(put.statusCode).toBe(204);

    const get = await app.inject({
      method: 'GET',
      url: '/v1/users/silent-golden-hawk',
      headers: { authorization: 'Bearer dvt_silent-golden-hawk' },
    });
    expect(get.json().selected_avatar_id).toBe('fox');

    // Repo state matches what we queried.
    expect((await repo.findById('silent-golden-hawk'))?.selectedAvatarId).toBe('fox');
    await app.close();
  });

  it('clears the selection when null is sent', async () => {
    const { app, repo } = await makeApp();
    await repo.setSelectedAvatar('silent-golden-hawk', 'fox');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: {
        authorization: 'Bearer dvt_silent-golden-hawk',
        'content-type': 'application/json',
      },
      payload: { animal_id: null },
    });
    expect(res.statusCode).toBe(204);
    expect((await repo.findById('silent-golden-hawk'))?.selectedAvatarId).toBeUndefined();
    await app.close();
  });

  it('rejects animal ids outside the launch set', async () => {
    // Typo guard. If this didn't fire, a peer could set
    // `selected_avatar_id = "i-am-an-elephant"` and break renders on
    // every other client (no matching SVG → blank tile).
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: {
        authorization: 'Bearer dvt_silent-golden-hawk',
        'content-type': 'application/json',
      },
      payload: { animal_id: 'unicorn' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('unknown_animal_id');
    await app.close();
  });

  it('accepts paid avatar ids (rc.6 catalog expansion)', async () => {
    // rc.6 added 12 rare + 4 legendary ids to KNOWN_ANIMAL_IDS.
    // Server doesn't gate ownership — that's the purchase-side
    // concern. It just stores whatever the client claims.
    const { app, repo } = await makeApp();
    for (const id of ['lynx', 'raven', 'dragon', 'phoenix', 'pigeon']) {
      const res = await app.inject({
        method: 'PUT',
        url: '/v1/users/me/avatar',
        headers: {
          authorization: 'Bearer dvt_silent-golden-hawk',
          'content-type': 'application/json',
        },
        payload: { animal_id: id },
      });
      expect(res.statusCode, `setAvatar(${id})`).toBe(204);
      expect((await repo.findById('silent-golden-hawk'))?.selectedAvatarId).toBe(id);
    }
    await app.close();
  });

  it('401 without bearer', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/users/me/avatar',
      headers: { 'content-type': 'application/json' },
      payload: { animal_id: 'fox' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('DELETE /v1/users/me', () => {
  it('deletes the account, tombstones the handle, and 410s subsequent GETs', async () => {
    const { app, repo } = await makeApp();
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer dvt_silent-golden-hawk' },
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toEqual({ ok: true });

    // The user row is gone.
    expect(await repo.findById('silent-golden-hawk')).toBeUndefined();
    // GET now returns 410 Gone (not 404) so peers can render the
    // peer-deleted in-chat system bubble. 404 would imply
    // "never existed" — a different UX path.
    const get = await app.inject({
      method: 'GET',
      url: '/v1/users/silent-golden-hawk',
      headers: { authorization: 'Bearer dvt_demo' },
    });
    expect(get.statusCode).toBe(410);
    expect(get.json()).toEqual({ error: 'user_deleted' });

    // Phase 1 keeps the handle re-claimable (enrollment cooldown is
    // Phase 2). Re-create still succeeds at the repo level — this
    // assertion documents the current behavior, not a guarantee.
    const reclaimed = await repo.tryCreate({
      userId: 'silent-golden-hawk',
      deviceToken: 'dvt_new-owner',
      publicKey: Buffer.from('new-pk'),
      bundle: bundle(),
    });
    expect(reclaimed).toBe(true);
    await app.close();
  });

  it('401 without bearer', async () => {
    const { app } = await makeApp();
    const res = await app.inject({ method: 'DELETE', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
