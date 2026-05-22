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

  it('persists the name and surfaces it on GET', async () => {
    const { app } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: callerHeader('alice'),
      payload: { name: 'Suckdix' },
    });
    expect(create.statusCode).toBe(201);
    const groupId = create.json().group_id;
    const get = await app.inject({
      method: 'GET',
      url: `/v1/groups/${groupId}`,
      headers: callerHeader('alice'),
    });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ name: 'Suckdix' });
    await app.close();
  });

  it('omits name → null in GET response (legacy clients)', async () => {
    const { app } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: callerHeader('alice'),
      payload: {},
    });
    const groupId = create.json().group_id;
    const get = await app.inject({
      method: 'GET',
      url: `/v1/groups/${groupId}`,
      headers: callerHeader('alice'),
    });
    expect(get.json().name).toBeNull();
    await app.close();
  });

  it('rejects oversized names by silently dropping (≤64 chars only)', async () => {
    const { app } = await makeApp();
    const create = await app.inject({
      method: 'POST',
      url: '/v1/groups',
      headers: callerHeader('alice'),
      payload: { name: 'x'.repeat(200) },
    });
    expect(create.statusCode).toBe(201);
    const groupId = create.json().group_id;
    const get = await app.inject({
      method: 'GET',
      url: `/v1/groups/${groupId}`,
      headers: callerHeader('alice'),
    });
    // Server silently drops the oversize name — group still creates,
    // but `name` falls back to null and the mobile client renders the
    // default "Room with @x, @y" label.
    expect(get.json().name).toBeNull();
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
    // Phase 2 brand overhaul: groups dropped the `avatar_b64` field.
    // Mobile renders the deterministic geometric room mark from `id`.
    expect(res.json()).toEqual({
      id: 'grp-test',
      created_by: 'alice',
      // rc.48 added groups.name (nullable until creators pass one
      // through POST /v1/groups). Existing test creates without a
      // name — null is the correct default.
      name: null,
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

// PUT /v1/groups/:id/avatar tests removed in Phase 2 — the route is
// gone (groups have no per-room photo or custom mark; the room mark
// is derived from the group id, see AVATAR-SYSTEM.md §7).

describe('GET /v1/groups/:id/members', () => {
  it('returns the roster + creator for a member', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-roster', createdBy: 'alice' });
    await repo.addMember({ groupId: 'grp-roster', userId: 'bob', addedBy: 'alice' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/groups/grp-roster/members',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.created_by).toBe('alice');
    expect((body.members as string[]).sort()).toEqual(['alice', 'bob']);
    await app.close();
  });

  it('403 for a non-member peeker', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-private', createdBy: 'alice' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/groups/grp-private/members',
      headers: callerHeader('mallory'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('DELETE /v1/groups/:id/members/:userId', () => {
  it('creator can evict a regular member; member count drops', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-kick', createdBy: 'alice' });
    await repo.addMember({ groupId: 'grp-kick', userId: 'bob', addedBy: 'alice' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/groups/grp-kick/members/bob',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toBe(1);
    expect(await repo.isMember('grp-kick', 'bob')).toBe(false);
    await app.close();
  });

  it('403 when a non-creator tries to evict', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-kick2', createdBy: 'alice' });
    await repo.addMember({ groupId: 'grp-kick2', userId: 'bob', addedBy: 'alice' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/groups/grp-kick2/members/alice',
      headers: callerHeader('bob'),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it('409 when creator tries to evict themselves', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-self', createdBy: 'alice' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/groups/grp-self/members/alice',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('cannot_remove_creator');
    await app.close();
  });
});

describe('PUT /v1/groups/:id/name', () => {
  it('creator can rename a group and members see the new name', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-rename', createdBy: 'alice', name: 'Old' });
    await repo.addMember({ groupId: 'grp-rename', userId: 'bob', addedBy: 'alice' });
    const rename = await app.inject({
      method: 'PUT',
      url: '/v1/groups/grp-rename/name',
      headers: callerHeader('alice'),
      payload: { name: 'New Room' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json()).toMatchObject({ name: 'New Room', created_by: 'alice' });
    const get = await app.inject({
      method: 'GET',
      url: '/v1/groups/grp-rename',
      headers: callerHeader('bob'),
    });
    expect(get.json().name).toBe('New Room');
    await app.close();
  });

  it('rejects non-creator and invalid names', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-rename2', createdBy: 'alice', name: 'Old' });
    await repo.addMember({ groupId: 'grp-rename2', userId: 'bob', addedBy: 'alice' });
    const nonCreator = await app.inject({
      method: 'PUT',
      url: '/v1/groups/grp-rename2/name',
      headers: callerHeader('bob'),
      payload: { name: 'Nope' },
    });
    expect(nonCreator.statusCode).toBe(403);
    const invalid = await app.inject({
      method: 'PUT',
      url: '/v1/groups/grp-rename2/name',
      headers: callerHeader('alice'),
      payload: { name: ' '.repeat(4) },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});

describe('POST /v1/groups/:id/leave', () => {
  it('regular member can leave the group', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-leave', createdBy: 'alice' });
    await repo.addMember({ groupId: 'grp-leave', userId: 'bob', addedBy: 'alice' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/groups/grp-leave/leave',
      headers: callerHeader('bob'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: 1, created_by: 'alice', deleted: false });
    expect(await repo.isMember('grp-leave', 'bob')).toBe(false);
    await app.close();
  });

  it('creator leave transfers ownership to a remaining member', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-transfer', createdBy: 'alice' });
    await repo.addMember({ groupId: 'grp-transfer', userId: 'bob', addedBy: 'alice' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/groups/grp-transfer/leave',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: 1, created_by: 'bob', deleted: false });
    expect((await repo.findById('grp-transfer'))?.createdBy).toBe('bob');
    await app.close();
  });

  it('last member leave deletes the group', async () => {
    const { app, repo } = await makeApp();
    await repo.create({ groupId: 'grp-empty', createdBy: 'alice' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/groups/grp-empty/leave',
      headers: callerHeader('alice'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ members: 0, created_by: null, deleted: true });
    expect(await repo.findById('grp-empty')).toBeUndefined();
    await app.close();
  });
});
