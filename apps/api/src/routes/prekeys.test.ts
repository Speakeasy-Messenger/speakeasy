import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryPreKeyRepo } from '../db/prekeys.memory.js';
import { InMemoryDeletedHandlesRepo } from '../db/deleted-handles.js';
import type { UserNotifier } from '../ws/user-notifier.js';
import { testIdentity } from '../crypto/xeddsa-testkit.js';

// The seeded account's identity. `/v1/prekeys/replenish` verifies that
// an uploaded signed prekey is signed by THIS key — a valid device
// token must not be able to swap the account's identity.
const HAWK = testIdentity('silent-golden-hawk');

/** A signed-prekey + matching XEdDSA signature from HAWK. */
function signedSpk(label: string) {
  const spk = Buffer.from(label);
  return {
    signedPreKey: spk.toString('base64'),
    signedPreKeySig: HAWK.sign(spk),
  };
}

function bundle(prekeyCount = 3) {
  return {
    registrationId: 1,
    signedPreKeyId: 100,
    signedPreKey: Buffer.from('spk').toString('base64'),
    signedPreKeySig: Buffer.from('sig').toString('base64'),
    preKeys: Array.from({ length: prekeyCount }, (_, i) => ({
      id: i + 1,
      key: Buffer.from(`k${i + 1}`).toString('base64'),
    })),
  };
}

/** Captures every notify() call so tests can assert on the resulting frames. */
class CapturingNotifier implements UserNotifier {
  readonly events: Array<{ userId: string; frame: object }> = [];
  notify(userId: string, frame: object): void {
    this.events.push({ userId, frame });
  }
}

async function makeApp(initialPreKeys = 3, notifier?: UserNotifier) {
  const userRepo = new InMemoryUserRepo();
  await userRepo.tryCreate({
    userId: 'silent-golden-hawk',
    deviceToken: 'dvt_silent-golden-hawk',
    // Real identity: replenish verifies the uploaded signed prekey
    // against this key, so the seeded account needs a genuine one.
    publicKey: Buffer.from(HAWK.publicKeyB64, 'base64'),
    bundle: bundle(initialPreKeys),
  });
  const preKeyRepo = new InMemoryPreKeyRepo(userRepo);
  const deletedHandles = new InMemoryDeletedHandlesRepo();
  const validator = MockValidator.fromMap({
    dvt_caller_hawk: {
      ok: true,
      attestation: { confidence: 'medium', userId: 'silent-golden-hawk' },
    },
    dvt_caller_anon: { ok: true, attestation: { confidence: 'medium' } },
  });
  const app = await buildServer({
    validator,
    userRepo,
    preKeyRepo,
    userNotifier: notifier,
    deletedHandles,
    logger: false,
  });
  return { app, preKeyRepo, userRepo, deletedHandles };
}

describe('POST /v1/prekeys/bundle', () => {
  it('returns and consumes a one-time prekey', async () => {
    const { app, preKeyRepo } = await makeApp();
    const before = await preKeyRepo.countRemaining('silent-golden-hawk');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_id).toBe('silent-golden-hawk');
    expect(body.identity_public_key).toBe(HAWK.publicKeyB64);
    expect(body.one_time_prekey?.id).toBe(1);
    expect(body.remaining_prekeys).toBe(before - 1);
    await app.close();
  });

  it('one_time_prekey is null once exhausted', async () => {
    const { app, preKeyRepo } = await makeApp();
    // Drain one-time keys.
    while ((await preKeyRepo.countRemaining('silent-golden-hawk')) > 0) {
      await preKeyRepo.fetchBundleConsume('silent-golden-hawk');
    }
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.one_time_prekey).toBeNull();
    expect(body.signed_prekey).toBeTruthy();
    await app.close();
  });

  it('404 when peer is not enrolled', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: { user_id: 'ghost-ghost-ghost' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('410 with user_deleted when peer handle is in the tombstone set', async () => {
    const { app, deletedHandles } = await makeApp();
    await deletedHandles.record('quiet-fox-river');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: { user_id: 'quiet-fox-river' },
    });
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: 'user_deleted' });
    await app.close();
  });

  it('400 on invalid id', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: { user_id: 'NOTVALID' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('401 without bearer', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('emits prekeys_low to the owner when remaining drops below threshold', async () => {
    // Seed exactly PREKEY_LOW_WATER (10) prekeys, then consume one. After
    // the bundle handler returns, 9 remain — below the 10-threshold.
    const notifier = new CapturingNotifier();
    const { app } = await makeApp(10, notifier);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(200);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).toEqual({
      userId: 'silent-golden-hawk',
      frame: { type: 'prekeys_low', remaining_prekeys: 9 },
    });
    await app.close();
  });

  it('does NOT emit prekeys_low when owner is above threshold', async () => {
    const notifier = new CapturingNotifier();
    const { app } = await makeApp(50, notifier);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/bundle',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(200);
    expect(notifier.events).toHaveLength(0);
    await app.close();
  });
});

describe('POST /v1/prekeys/replenish', () => {
  it("replaces caller's prekey inventory", async () => {
    const { app, preKeyRepo } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/replenish',
      headers: { authorization: 'Bearer dvt_caller_hawk' },
      payload: {
        signedPreKeyId: 200,
        ...signedSpk('newspk'),
        preKeys: [
          { id: 99, key: Buffer.from('a').toString('base64') },
          { id: 100, key: Buffer.from('b').toString('base64') },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().remaining_prekeys).toBe(2);
    expect(await preKeyRepo.countRemaining('silent-golden-hawk')).toBe(2);
    await app.close();
  });

  it('403 when caller token has no userId', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/replenish',
      headers: { authorization: 'Bearer dvt_caller_anon' },
      payload: {
        signedPreKeyId: 1,
        signedPreKey: 'a',
        signedPreKeySig: 'b',
        preKeys: [{ id: 1, key: 'c' }],
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  // Identity continuity. Regression guard for the 2026-08-07 hole: a
  // device token that outlived its Signal store (iOS keychain surviving
  // an app reinstall, or a stolen token) could upload a bundle signed by
  // a DIFFERENT identity and silently take over the account's effective
  // identity — bypassing /v1/devices/rebind, which exists precisely to
  // demand proof of identity-key ownership before rebinding a handle.
  it('rejects a bundle signed by a different identity (403 identity_mismatch)', async () => {
    const { app, preKeyRepo } = await makeApp();
    const attacker = testIdentity('attacker');
    const spk = Buffer.from('attacker-spk');
    const before = await preKeyRepo.countRemaining('silent-golden-hawk');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/replenish',
      // A perfectly valid device token for this account…
      headers: { authorization: 'Bearer dvt_caller_hawk' },
      payload: {
        signedPreKeyId: 200,
        // …but a bundle signed by an identity the account never enrolled.
        signedPreKey: spk.toString('base64'),
        signedPreKeySig: attacker.sign(spk),
        preKeys: [{ id: 99, key: Buffer.from('a').toString('base64') }],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('identity_mismatch');
    // Inventory untouched — the rejected upload must not partially apply.
    expect(await preKeyRepo.countRemaining('silent-golden-hawk')).toBe(before);
    await app.close();
  });

  it('rejects a well-formed bundle whose signature does not verify', async () => {
    const { app } = await makeApp();
    const spk = Buffer.from('newspk');
    const sig = Buffer.from(HAWK.sign(spk), 'base64');
    sig[5]! ^= 0x01; // corrupt one byte of an otherwise-valid signature

    const res = await app.inject({
      method: 'POST',
      url: '/v1/prekeys/replenish',
      headers: { authorization: 'Bearer dvt_caller_hawk' },
      payload: {
        signedPreKeyId: 201,
        signedPreKey: spk.toString('base64'),
        signedPreKeySig: sig.toString('base64'),
        preKeys: [{ id: 99, key: Buffer.from('a').toString('base64') }],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('identity_mismatch');
    await app.close();
  });
});
