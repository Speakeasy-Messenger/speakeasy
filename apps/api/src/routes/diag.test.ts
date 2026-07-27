import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { buildServer } from '../server.js';
import { InMemoryUserRepo } from '../db/users.memory.js';
import { InMemoryDiagUploadsRepo } from '../db/diag.memory.js';

let app: Awaited<ReturnType<typeof buildServer>>;
let userRepo: InMemoryUserRepo;
let diagUploads: InMemoryDiagUploadsRepo;

const BETA = '1.0.50-rc.5';
const GA = '1.0.50';

async function enroll(userId: string, deviceToken: string): Promise<void> {
  await userRepo.tryCreate({
    userId,
    deviceToken,
    publicKey: Buffer.from([0]),
    bundle: {
      registrationId: 1,
      signedPreKeyId: 1,
      signedPreKey: '',
      signedPreKeySig: '',
      preKeys: [],
    },
  });
}

beforeEach(async () => {
  userRepo = new InMemoryUserRepo();
  diagUploads = new InMemoryDiagUploadsRepo();
  await enroll('alpha', 'dvt_alpha');
  await enroll('beta', 'dvt_beta');
  // Resolve the bearer token straight through to a deviceToken; the user
  // repo maps it back to the enrolled userId.
  app = await buildServer({
    validator: new MockValidator((tok) => ({
      ok: true,
      attestation: { confidence: 'medium' },
      deviceToken: tok,
    })),
    userRepo,
    diagUploads,
    skipWebsocket: true,
    logger: false,
  });
});

afterEach(async () => {
  if (app) await app.close();
});

function post(token: string, body: unknown) {
  return app.inject({
    method: 'POST',
    url: '/v1/diag',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body as Record<string, unknown>,
  });
}

describe('POST /v1/diag', () => {
  it('rejects unauthenticated callers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/diag',
      payload: { entries: [], appVersion: BETA, reason: 'manual' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts + stores a beta upload', async () => {
    const res = await post('dvt_alpha', {
      entries: [{ t: 1, tag: 'call', msg: 'startOutgoing' }],
      appVersion: BETA,
      reason: 'manual',
    });
    expect(res.statusCode).toBe(200);
    const rows = await diagUploads.listByUser('alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.appVersion).toBe(BETA);
    expect(rows[0]!.reason).toBe('manual');
    expect(rows[0]!.entries).toEqual([{ t: 1, tag: 'call', msg: 'startOutgoing' }]);
  });

  it('403s a GA version so GA clients cannot write', async () => {
    const res = await post('dvt_alpha', {
      entries: [{ t: 1, tag: 'call', msg: 'x' }],
      appVersion: GA,
      reason: 'manual',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'not_beta' });
    expect(await diagUploads.listByUser('alpha')).toHaveLength(0);
  });

  it('correlates both sides of a call: listByCallId returns both users rows', async () => {
    const callId = 'call-xyz';
    await post('dvt_alpha', {
      entries: [{ t: 1, tag: 'call', msg: 'caller' }],
      appVersion: BETA,
      reason: 'call_failed',
      callId,
    });
    await post('dvt_beta', {
      entries: [{ t: 2, tag: 'call', msg: 'callee' }],
      appVersion: BETA,
      reason: 'call_failed',
      callId,
    });
    const rows = await diagUploads.listByCallId(callId);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.userId))).toEqual(new Set(['alpha', 'beta']));
  });

  it('rejects an oversized entries array', async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      t: i,
      tag: 'call',
      msg: 'x',
    }));
    const res = await post('dvt_alpha', { entries, appVersion: BETA, reason: 'manual' });
    expect(res.statusCode).toBe(400);
    expect(await diagUploads.listByUser('alpha')).toHaveLength(0);
  });

  it('scrubs unknown entry keys (defense-in-depth) and drops malformed entries', async () => {
    const res = await post('dvt_alpha', {
      entries: [
        { t: 1, tag: 'call', msg: 'ok', ctx: { a: 1 }, secret: 'plaintext-handle' },
        { tag: 'call', msg: 'no-timestamp' }, // malformed → dropped
      ],
      appVersion: BETA,
      reason: 'manual',
    });
    expect(res.statusCode).toBe(200);
    const rows = await diagUploads.listByUser('alpha');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.entries).toEqual([{ t: 1, tag: 'call', msg: 'ok', ctx: { a: 1 } }]);
    expect(JSON.stringify(rows[0]!.entries)).not.toContain('plaintext-handle');
  });
});
