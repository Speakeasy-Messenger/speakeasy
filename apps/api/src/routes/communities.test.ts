import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { isCommunityId } from '@speakeasy/shared';
import { buildServer } from '../server.js';
import { InMemoryCommunityRepo } from '../db/communities.memory.js';
// Subpath import: `SoftwareChannelKeyModule` is not on the public
// `@speakeasy/crypto` index because it depends on `node:crypto` (Node-only)
// which crashes the React Native Metro bundler. Server-side tests reach
// it via the dedicated subpath export — see packages/crypto/package.json.
import { SoftwareChannelKeyModule } from '@speakeasy/crypto/software-channel-key';
import { randomBytes } from 'node:crypto';

const callerHeader = (userId: string) => ({ authorization: `Bearer dvt_${userId}` });

function makeValidator() {
  return new MockValidator((tok) => {
    if (tok === 'dvt_anon') return { ok: true, attestation: { confidence: 'medium' } };
    if (tok.startsWith('dvt_')) {
      return { ok: true, attestation: { confidence: 'medium', userId: tok.slice(4) } };
    }
    return { ok: false, reason: 'device_not_found' };
  });
}

async function makeApp() {
  const repo = new InMemoryCommunityRepo();
  const app = await buildServer({
    validator: makeValidator(),
    communityRepo: repo,
    logger: false,
  });
  return { app, repo };
}

async function createCommunity(app: Awaited<ReturnType<typeof buildServer>>, asUser: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/communities',
    headers: callerHeader(asUser),
    payload: {},
  });
  return res.json().community_id as string;
}

describe('POST /v1/communities', () => {
  it('creates a community; caller becomes moderator', async () => {
    const { app, repo } = await makeApp();
    const id = await createCommunity(app, 'alice');
    expect(isCommunityId(id)).toBe(true);
    expect(await repo.isModerator(id, 'alice')).toBe(true);
    await app.close();
  });

  it('rejects ttl_days outside range', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/communities',
      headers: callerHeader('alice'),
      payload: { ttl_days: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /v1/communities/:id/members', () => {
  it('member adds another member', async () => {
    const { app, repo } = await makeApp();
    const cid = await createCommunity(app, 'alice');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/members`,
      headers: callerHeader('alice'),
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(201);
    expect(await repo.isMember(cid, 'silent-golden-hawk')).toBe(true);
    await app.close();
  });

  it('403 when adder is not a member', async () => {
    const { app } = await makeApp();
    const cid = await createCommunity(app, 'alice');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/members`,
      headers: callerHeader('outsider'),
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /v1/communities/:id/envelopes + GET /v1/communities/:id/key', () => {
  it('envelope upload + fetch round-trips a wrapped key', async () => {
    const { app } = await makeApp();
    const cid = await createCommunity(app, 'alice');

    // Add hawk so they can receive an envelope.
    await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/members`,
      headers: callerHeader('alice'),
      payload: { user_id: 'silent-golden-hawk' },
    });

    // Alice's device wraps the channel key for hawk's device. We use the
    // SoftwareChannelKeyModule with a shared test secret so wrap + unwrap
    // can be done in-process.
    const secret = new Uint8Array(randomBytes(32));
    const aliceCrypto = new SoftwareChannelKeyModule(secret);
    const hawkCrypto = new SoftwareChannelKeyModule(secret);
    const K = await aliceCrypto.generateChannelKey();
    const envelope = await aliceCrypto.wrapForRecipient(K, new Uint8Array([1, 2, 3]));

    const upload = await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/envelopes`,
      headers: callerHeader('alice'),
      payload: {
        recipient_user_id: 'silent-golden-hawk',
        wrapped_key: Buffer.from(envelope).toString('base64'),
        key_epoch: 1,
      },
    });
    expect(upload.statusCode).toBe(201);

    // Hawk fetches their envelope and unwraps to the same K.
    const fetch = await app.inject({
      method: 'GET',
      url: `/v1/communities/${cid}/key`,
      headers: callerHeader('silent-golden-hawk'),
    });
    expect(fetch.statusCode).toBe(200);
    const body = fetch.json();
    expect(body.recipient_user_id).toBe('silent-golden-hawk');
    expect(body.wrapped_by_user_id).toBe('alice');
    expect(body.key_epoch).toBe(1);

    const wrapped = Buffer.from(body.wrapped_key, 'base64');
    const recoveredK = await hawkCrypto.unwrapForSelf(new Uint8Array(wrapped));
    expect(Buffer.from(recoveredK).equals(Buffer.from(K))).toBe(true);

    await app.close();
  });

  it('GET key returns latest epoch on rotation', async () => {
    const { app } = await makeApp();
    const cid = await createCommunity(app, 'alice');
    await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/members`,
      headers: callerHeader('alice'),
      payload: { user_id: 'silent-golden-hawk' },
    });
    for (const epoch of [1, 2, 3]) {
      await app.inject({
        method: 'POST',
        url: `/v1/communities/${cid}/envelopes`,
        headers: callerHeader('alice'),
        payload: {
          recipient_user_id: 'silent-golden-hawk',
          wrapped_key: Buffer.from(`v${epoch}`).toString('base64'),
          key_epoch: epoch,
        },
      });
    }
    const res = await app.inject({
      method: 'GET',
      url: `/v1/communities/${cid}/key`,
      headers: callerHeader('silent-golden-hawk'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().key_epoch).toBe(3);
    await app.close();
  });

  it('upload rejected if caller is not a member', async () => {
    const { app } = await makeApp();
    const cid = await createCommunity(app, 'alice');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/envelopes`,
      headers: callerHeader('outsider'),
      payload: {
        recipient_user_id: 'silent-golden-hawk',
        wrapped_key: 'AAA=',
      },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('upload rejected if recipient is not a member', async () => {
    const { app } = await makeApp();
    const cid = await createCommunity(app, 'alice');
    const res = await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/envelopes`,
      headers: callerHeader('alice'),
      payload: {
        recipient_user_id: 'silent-golden-hawk',
        wrapped_key: 'AAA=',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('recipient_not_member');
    await app.close();
  });

  it('GET key returns 404 when no envelope exists for caller', async () => {
    const { app } = await makeApp();
    const cid = await createCommunity(app, 'alice');
    await app.inject({
      method: 'POST',
      url: `/v1/communities/${cid}/members`,
      headers: callerHeader('alice'),
      payload: { user_id: 'silent-golden-hawk' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/communities/${cid}/key`,
      headers: callerHeader('silent-golden-hawk'),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('GET key 403 if caller is not a member', async () => {
    const { app } = await makeApp();
    const cid = await createCommunity(app, 'alice');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/communities/${cid}/key`,
      headers: callerHeader('outsider'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
