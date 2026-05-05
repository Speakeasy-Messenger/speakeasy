import { describe, expect, it } from 'vitest';
import { MockValidator } from '@speakeasy/vouchflow';
import { isGroupId } from '@speakeasy/shared';
import { buildServer } from '../server.js';
import { InMemoryGroupRepo } from '../db/groups.memory.js';
import { SMALL_GROUP_MAX_MEMBERS } from '../db/groups.js';

const callerToken = (userId: string) => `dvt_${userId}`;
const callerHeader = (userId: string) => ({ authorization: `Bearer ${callerToken(userId)}` });

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
  const repo = new InMemoryGroupRepo();
  const app = await buildServer({
    validator: makeValidator(),
    groupRepo: repo,
    logger: false,
  });
  return { app, repo };
}

describe('POST /v1/groups', () => {
  it('creates a group; caller becomes member', async () => {
    const { app, repo } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: callerHeader('alice'),
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const id: string = res.json().group_id;
    expect(isGroupId(id)).toBe(true);
    expect(await repo.isMember(id, 'alice')).toBe(true);
    await app.close();
  });

  it('403 when caller has no userId (not enrolled)', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: { authorization: 'Bearer dvt_anon' },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('POST /v1/groups/:id/members', () => {
  it('adds a member; new count returned', async () => {
    const { app, repo } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: callerHeader('alice'),
      payload: {},
    });
    const groupId = create.json().group_id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/groups/${groupId}/members`,
      headers: callerHeader('alice'),
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().members).toBe(2);
    expect(await repo.isMember(groupId, 'silent-golden-hawk')).toBe(true);
    await app.close();
  });

  it('403 when adder is not a member', async () => {
    const { app } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: callerHeader('alice'),
      payload: {},
    });
    const groupId = create.json().group_id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/groups/${groupId}/members`,
      headers: callerHeader('outsider'),
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('400 on invalid id', async () => {
    const { app } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: callerHeader('alice'),
      payload: {},
    });
    const groupId = create.json().group_id as string;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/groups/${groupId}/members`,
      headers: callerHeader('alice'),
      payload: { user_id: 'NOTVALID' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('409 group_full at the 100-member ceiling', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-test', createdBy: 'alice' });
    for (let i = 1; i < SMALL_GROUP_MAX_MEMBERS; i++) {
      await repo.addMember({ groupId: 'grp-test', userId: `user-num-${i}`, addedBy: 'alice' });
    }
    const res = await app.inject({
      method: 'POST',
      url: `/v1/groups/grp-test/members`,
      headers: callerHeader('alice'),
      payload: { user_id: 'overflow-overflow-overflow' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('group_full');
    await app.close();
  });

  it('404 group_missing', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/groups/grp-missing/members',
      headers: callerHeader('alice'),
      payload: { user_id: 'silent-golden-hawk' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /v1/groups/:id', () => {
  async function setupGroup() {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-test', createdBy: 'alice' });
    await repo.addMember({ groupId: 'grp-test', userId: 'bob', addedBy: 'alice' });
    return { app, repo };
  }

  it('returns metadata for a member', async () => {
    const { app } = await setupGroup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/groups/grp-test',
      headers: callerHeader('bob'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: 'grp-test',
      created_by: 'alice',
      avatar_b64: null,
    });
    await app.close();
  });

  it('403 not_member for an outsider', async () => {
    const { app } = await setupGroup();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/groups/grp-test',
      headers: callerHeader('eve'),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_member');
    await app.close();
  });

  it('404 for a missing group', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/groups/grp-nope',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('PUT /v1/groups/:id/avatar', () => {
  async function setupGroup() {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-test', createdBy: 'alice' });
    await repo.addMember({ groupId: 'grp-test', userId: 'bob', addedBy: 'alice' });
    return { app, repo };
  }

  it('lets the creator set the avatar; GET reflects it', async () => {
    const { app } = await setupGroup();
    const sample = Buffer.from('group-jpeg').toString('base64');
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/groups/grp-test/avatar',
      headers: { ...callerHeader('alice'), 'content-type': 'application/json' },
      payload: { avatar_b64: sample },
    });
    expect(put.statusCode).toBe(204);
    const get = await app.inject({
      method: 'GET',
      url: '/v1/groups/grp-test',
      headers: callerHeader('alice'),
    });
    expect(get.json().avatar_b64).toBe(sample);
    await app.close();
  });

  it('403 not_creator when a non-creator member tries', async () => {
    const { app } = await setupGroup();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/groups/grp-test/avatar',
      headers: { ...callerHeader('bob'), 'content-type': 'application/json' },
      payload: { avatar_b64: 'AAA=' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('not_creator');
    await app.close();
  });

  it('null clears the avatar', async () => {
    const { app, repo } = await setupGroup();
    await repo.setAvatar('grp-test', 'old-avatar');
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/groups/grp-test/avatar',
      headers: { ...callerHeader('alice'), 'content-type': 'application/json' },
      payload: { avatar_b64: null },
    });
    expect(res.statusCode).toBe(204);
    expect((await repo.findById('grp-test'))?.avatarB64).toBeUndefined();
    await app.close();
  });

  it('404 for a missing group', async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/groups/grp-nope/avatar',
      headers: { ...callerHeader('alice'), 'content-type': 'application/json' },
      payload: { avatar_b64: 'AAA=' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
