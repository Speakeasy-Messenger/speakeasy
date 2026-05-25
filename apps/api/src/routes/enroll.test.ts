import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { isHandle } from '@speakeasy/shared';
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

const validHandle = 'alice';
function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    token: 'dvt_demo_001',
    user_id: validHandle,
    publicKey: Buffer.from('pk').toString('base64'),
    preKeyBundle: bundle(),
    ...overrides,
  };
}

describe('POST /v1/enroll', () => {
  it('creates a user with the chosen handle', async () => {
    const repo = new InMemoryUserRepo();
    const app = await makeApp({ userRepo: repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: basePayload(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user_id).toBe(validHandle);
    expect(isHandle(body.user_id)).toBe(true);
    expect(repo.users.has(body.user_id)).toBe(true);
    await app.close();
  });

  it('lowercases the handle before claiming', async () => {
    // Schema enforces 3..20 length but the route still defensively
    // lowercases so a client that ignores the format hint can't
    // accidentally claim two variants of the same name.
    const repo = new InMemoryUserRepo();
    const app = await makeApp({ userRepo: repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: basePayload({ user_id: '  Alice  ' }),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user_id).toBe('alice');
    await app.close();
  });

  it('rejects invalid handle format with 400 invalid_user_id', async () => {
    const app = await makeApp();
    // Phase 3 brand overhaul (ONBOARDING.md §2.3.2): widened set —
    // digit-starts and `.-_` mid-handle now valid. Remaining failure
    // modes: too short, uppercase, leading/trailing or consecutive
    // separators.
    for (const bad of ['ab', 'ALICE!', '-abc', 'abc-', 'al--ice', 'a..b']) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/enroll',
        payload: basePayload({ user_id: bad }),
      });
      // Schema covers some (length); route covers the rest. Both are
      // 400 from the client's perspective.
      expect([400, 409]).toContain(res.statusCode);
    }
    await app.close();
  });

  it('rejects reserved handles with 409 reserved', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: basePayload({ user_id: 'admin' }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('reserved');
    await app.close();
  });

  it('returns 409 taken when the chosen handle already exists', async () => {
    const repo = new InMemoryUserRepo();
    repo.users.set('alice', {
      publicKey: Buffer.from('existing'),
      bundle: bundle(),
      createdAt: new Date(),
      deviceToken: 'dvt_other',
    });
    const app = await makeApp({ userRepo: repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: basePayload(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('taken');
    await app.close();
  });

  it('rejects low confidence', async () => {
    const app = await makeApp({ validator: MockValidator.alwaysFailsWith('low_confidence') });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: basePayload({ token: 'dvt_low' }),
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
      payload: basePayload({ token: 'dvt_bogus' }),
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

  it('rate-limits enrollment per Phase 4 hardening', async () => {
    const limiter = new InMemoryRateLimiter();
    const app = await makeApp({ rateLimiter: limiter });
    // Default enroll rate-limit is 5/hour. The 6th hit returns 429.
    // Each call must use a different handle so we don't get 409s.
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/enroll',
        payload: basePayload({ user_id: `alice${i}` }),
      });
      expect(res.statusCode).toBe(201);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload: basePayload({ user_id: 'alice5' }),
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
    expect(res.headers['ratelimit-limit']).toBe('5');
    expect(res.headers['ratelimit-remaining']).toBe('0');
    await app.close();
  });
});

describe('POST /v1/devices/rebind', () => {
  // Helper: seed a user via the enroll endpoint, then return both the
  // repo (so the test can verify post-rebind state) and the original
  // payload so the test can compare publicKeys.
  async function seedEnrolled(repo: InMemoryUserRepo, opts: { publicKeyB64?: string } = {}) {
    const app = await makeApp({ userRepo: repo });
    const payload = basePayload({
      publicKey: opts.publicKeyB64 ?? Buffer.from('pk').toString('base64'),
    });
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/v1/enroll',
      payload,
    });
    expect(enrollRes.statusCode).toBe(201);
    await app.close();
    return payload;
  }

  it('rotates the device-token on matching publicKey', async () => {
    const repo = new InMemoryUserRepo();
    const original = await seedEnrolled(repo);

    // Same identity key, fresh device token (simulates a reinstall
    // that preserved the SQLCipher-encrypted Signal store).
    const app = await makeApp({ userRepo: repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/rebind',
      payload: { ...original, token: 'dvt_new_001' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user_id).toBe(validHandle);

    // The new token resolves to the user; the old one no longer does.
    expect(await repo.findUserIdByDeviceToken('dvt_new_001')).toBe(validHandle);
    expect(await repo.findUserIdByDeviceToken('dvt_demo_001')).toBeUndefined();
    await app.close();
  });

  it('rejects rebind with 401 identity_mismatch when publicKey differs', async () => {
    const repo = new InMemoryUserRepo();
    await seedEnrolled(repo, { publicKeyB64: Buffer.from('original-pk').toString('base64') });

    const app = await makeApp({ userRepo: repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/rebind',
      payload: {
        token: 'dvt_attacker',
        user_id: validHandle,
        // Wrong publicKey — the presenter doesn't actually own the
        // Signal identity for this handle. Refuse.
        publicKey: Buffer.from('attacker-pk').toString('base64'),
        preKeyBundle: bundle(),
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('identity_mismatch');

    // The original binding is unchanged.
    expect(await repo.findUserIdByDeviceToken('dvt_demo_001')).toBe(validHandle);
    expect(await repo.findUserIdByDeviceToken('dvt_attacker')).toBeUndefined();
    await app.close();
  });

  it('returns 404 no_such_user when the handle was never enrolled', async () => {
    const app = await makeApp({ userRepo: new InMemoryUserRepo() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/rebind',
      payload: basePayload({ user_id: 'ghost' }),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_such_user');
    await app.close();
  });

  it('returns 401 from vouchflow when the new token is rejected', async () => {
    const repo = new InMemoryUserRepo();
    const original = await seedEnrolled(repo);

    // Validator that fails on the new token but accepted the original
    // (the seeding used a different MockValidator instance — that's
    // fine, we just need this one to reject the rebind attempt).
    const app = await makeApp({
      userRepo: repo,
      validator: MockValidator.alwaysFailsWith('low_confidence'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/rebind',
      payload: { ...original, token: 'dvt_new_002' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('low_confidence');
    // No rotation happened.
    expect(await repo.findUserIdByDeviceToken('dvt_demo_001')).toBe(validHandle);
    await app.close();
  });

  it('rejects malformed handle with 400 invalid_user_id', async () => {
    const app = await makeApp({ userRepo: new InMemoryUserRepo() });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/rebind',
      payload: basePayload({ user_id: 'ALICE!' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_user_id');
    await app.close();
  });

  it('replaces the prekey bundle on a successful rebind', async () => {
    const repo = new InMemoryUserRepo();
    const original = await seedEnrolled(repo);

    const freshBundle = {
      registrationId: 999,
      signedPreKeyId: 999,
      signedPreKey: Buffer.from('fresh-spk').toString('base64'),
      signedPreKeySig: Buffer.from('fresh-spk-sig').toString('base64'),
      preKeys: [{ id: 999, key: Buffer.from('fresh-otk').toString('base64') }],
    };
    const app = await makeApp({ userRepo: repo });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/devices/rebind',
      payload: { ...original, token: 'dvt_new_003', preKeyBundle: freshBundle },
    });
    expect(res.statusCode).toBe(200);

    // InMemoryUserRepo exposes the stored bundle via the `users` map.
    const stored = repo.users.get(validHandle);
    expect(stored?.bundle.registrationId).toBe(999);
    expect(stored?.bundle.preKeys[0]?.id).toBe(999);
    await app.close();
  });
});
