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
    // ttl_days=0 violates the lower bound (must be ≥1)
    const res = await app.inject({
      method: 'POST',
      url: '/v1/communities',
      headers: callerHeader('alice'),
      payload: { ttl_days: 0 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('caps ttl_days at 365 days (spec §13: long-arc ephemeral)', async () => {
    // Phase 5g policy decision: moderators can configure community
    // message TTL from 1 day to 1 year. 1 year is the ceiling —
    // longer values let a "community" become an effectively-permanent
    // archive, which doesn't fit the product's ephemeral framing.
    // Default stays 7 days (set in the schema, applied when ttl_days
    // is omitted).
    const { app } = await makeApp();

    // 366 days is over the cap.
    const tooLong = await app.inject({
      method: 'POST',
      url: '/v1/communities',
      headers: callerHeader('alice'),
      payload: { ttl_days: 366 },
    });
    expect(tooLong.statusCode).toBe(400);

    // Right at the cap (365) is fine.
    const atCap = await app.inject({
      method: 'POST',
      url: '/v1/communities',
      headers: callerHeader('alice'),
      payload: { ttl_days: 365 },
    });
    expect(atCap.statusCode).toBe(201);

    // Tightening to 1 day works.
    const tighter = await app.inject({
      method: 'POST',
      url: '/v1/communities',
      headers: callerHeader('alice'),
      payload: { ttl_days: 1 },
    });
    expect(tighter.statusCode).toBe(201);

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

describe('DELETE /v1/communities/:id/members/:user_id (auto-rotate on leave)', () => {
  /**
   * In-process notifier captures every (userId, frame) pair so tests
   * can assert exactly which members got the rotation signal.
   */
  class CapturingNotifier {
    readonly calls: Array<{ userId: string; frame: object }> = [];
    notify(userId: string, frame: object): void {
      this.calls.push({ userId, frame });
    }
  }

  async function makeAppWithNotifier(): Promise<{
    app: Awaited<ReturnType<typeof buildServer>>;
    repo: InMemoryCommunityRepo;
    notifier: CapturingNotifier;
  }> {
    const repo = new InMemoryCommunityRepo();
    const notifier = new CapturingNotifier();
    const app = await buildServer({
      validator: makeValidator(),
      communityRepo: repo,
      userNotifier: notifier,
      logger: false,
    });
    return { app, repo, notifier };
  }

  async function setupCommunityWithMembers(
    app: Awaited<ReturnType<typeof buildServer>>,
    moderator: string,
    members: string[],
  ): Promise<string> {
    const cid = await createCommunity(app, moderator);
    for (const m of members) {
      await app.inject({
        method: 'POST',
        url: `/v1/communities/${cid}/members`,
        headers: callerHeader(moderator),
        payload: { user_id: m },
      });
    }
    return cid;
  }

  it('moderator removes a member; rotation signal fires for each remaining member', async () => {
    const { app, repo, notifier } = await makeAppWithNotifier();
    const cid = await setupCommunityWithMembers(app, 'alice', ['bob', 'carol', 'dave']);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/communities/${cid}/members/bob`,
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ remaining_members: 3 });

    expect(await repo.isMember(cid, 'bob')).toBe(false);
    expect(await repo.isMember(cid, 'alice')).toBe(true);
    expect(await repo.isMember(cid, 'carol')).toBe(true);
    expect(await repo.isMember(cid, 'dave')).toBe(true);

    // Rotation signal sent to all REMAINING members. Bob (the removed
    // user) MUST NOT receive it — that would leak the rotation event
    // back to the user we're revoking.
    const recipients = notifier.calls.map((c) => c.userId).sort();
    expect(recipients).toEqual(['alice', 'carol', 'dave']);
    for (const call of notifier.calls) {
      expect(call.frame).toEqual({
        type: 'channel_key_rotation_required',
        community_id: cid,
        reason: 'member_removed',
      });
    }
    await app.close();
  });

  it('member can remove themselves (self-leave)', async () => {
    const { app, repo, notifier } = await makeAppWithNotifier();
    const cid = await setupCommunityWithMembers(app, 'alice', ['bob']);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/communities/${cid}/members/bob`,
      headers: callerHeader('bob'),
    });
    expect(res.statusCode).toBe(200);
    expect(await repo.isMember(cid, 'bob')).toBe(false);
    expect(notifier.calls.map((c) => c.userId)).toEqual(['alice']);
    await app.close();
  });

  it('non-moderator cannot remove someone else', async () => {
    const { app, notifier } = await makeAppWithNotifier();
    const cid = await setupCommunityWithMembers(app, 'alice', ['bob', 'carol']);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/communities/${cid}/members/carol`,
      headers: callerHeader('bob'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_moderator');
    expect(notifier.calls).toHaveLength(0);
    await app.close();
  });

  it('returns 404 for not-a-member; no rotation signal fires', async () => {
    const { app, notifier } = await makeAppWithNotifier();
    const cid = await setupCommunityWithMembers(app, 'alice', ['bob']);

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/communities/${cid}/members/carol`,
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_a_member');
    expect(notifier.calls).toHaveLength(0);
    await app.close();
  });

  it('returns 404 for missing community (self-remove path, bypasses moderator gate)', async () => {
    // The moderator-authz gate fires before existence check for
    // non-self removals (privacy: outsiders can't probe community
    // existence via DELETE). The self-remove path skips that gate
    // and surfaces the underlying community_missing as 404.
    const { app, notifier } = await makeAppWithNotifier();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/communities/com-01HZZZNOTREALCOMMUNITYAA/members/alice',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('community_missing');
    expect(notifier.calls).toHaveLength(0);
    await app.close();
  });

  it('returns 403 not_moderator for non-self DELETE on missing community (privacy)', async () => {
    // Authz gate fires before existence check — an outsider probing
    // for community ids gets the same 403 whether the community
    // exists or not.
    const { app, notifier } = await makeAppWithNotifier();
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/communities/com-01HZZZNOTREALCOMMUNITYAA/members/bob',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_moderator');
    expect(notifier.calls).toHaveLength(0);
    await app.close();
  });

  it('after removal, the leaver loses access via /key (gated by isMember)', async () => {
    const { app } = await makeAppWithNotifier();
    const cid = await setupCommunityWithMembers(app, 'alice', ['bob']);

    // Bob passes the gate while a member (404 no_envelope, not 403).
    let res = await app.inject({
      method: 'GET',
      url: `/v1/communities/${cid}/key`,
      headers: callerHeader('bob'),
    });
    expect(res.statusCode).toBe(404);

    await app.inject({
      method: 'DELETE',
      url: `/v1/communities/${cid}/members/bob`,
      headers: callerHeader('alice'),
    });

    // Bob now hits the 403 not_member gate before getLatestEnvelope.
    res = await app.inject({
      method: 'GET',
      url: `/v1/communities/${cid}/key`,
      headers: callerHeader('bob'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_member');
    await app.close();
  });
});
