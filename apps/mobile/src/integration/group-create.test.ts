import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Harness, makeClient, makeHarness } from './harness.js';
import { useGroups } from '../store/groups.js';

/**
 * Reproduces the user-reported bug from 0.2.8: "creating group chat
 * doesnt work". User saw a failure (we never got the diag log; likely
 * either the server rejected something or the orchestrator threw).
 *
 * This Tier A test drives the same JS-layer path NewGroupScreen does:
 * api.createGroup → loop addGroupMember → upsert into useGroups. If
 * the JS layer is sound, the bug is downstream (UI state, orchestrator,
 * or a real on-device-only issue that needs Tier B coverage).
 */

describe('group create — JS layer end-to-end', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness({
      users: {
        dvt_alice: 'alice-blue-fox',
        dvt_bob: 'bob-red-bear',
        dvt_carol: 'carol-pink-owl',
      },
      preEnroll: ['alice-blue-fox', 'bob-red-bear', 'carol-pink-owl'],
    });
    useGroups.getState().reset();
  });
  afterEach(async () => {
    useGroups.getState().reset();
    await h.teardown();
  });

  it('createGroup mints a group_id and addGroupMember adds peers', async () => {
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const { group_id } = await alice.api.createGroup(alice.deviceToken);
    expect(group_id).toMatch(/^grp-[0-9A-HJKMNP-TV-Z]{26}$/);

    const r1 = await alice.api.addGroupMember(alice.deviceToken, group_id, 'bob-red-bear');
    expect(r1.members).toBe(2);
    const r2 = await alice.api.addGroupMember(alice.deviceToken, group_id, 'carol-pink-owl');
    expect(r2.members).toBe(3);

    alice.close();
  });

  it('addGroupMember accepts a peer who has never enrolled (server permissive; precheck happens client-side or never)', async () => {
    // The server's addMember route only checks (1) caller is a member,
    // (2) target is a syntactically valid user id, (3) group not full.
    // It does NOT check whether the target is enrolled. This is the
    // intended behavior so groups can be created with people you've
    // exchanged ids out-of-band but who haven't installed yet.
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const { group_id } = await alice.api.createGroup(alice.deviceToken);
    const r = await alice.api.addGroupMember(
      alice.deviceToken,
      group_id,
      'never-enrolled-anyone',
    );
    expect(r.members).toBe(2);
    alice.close();
  });

  it('addGroupMember rejects malformed peer ids (400)', async () => {
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const { group_id } = await alice.api.createGroup(alice.deviceToken);
    await expect(
      alice.api.addGroupMember(alice.deviceToken, group_id, 'NOT_VALID_ID'),
    ).rejects.toThrow();
    alice.close();
  });

  it('addGroupMember rejects when caller is not a member (403)', async () => {
    const alice = await makeClient(h, { token: 'dvt_alice', userId: 'alice-blue-fox' });
    const bob = await makeClient(h, { token: 'dvt_bob', userId: 'bob-red-bear' });
    const { group_id } = await alice.api.createGroup(alice.deviceToken);
    // bob isn't on the group; tries to add carol → 403.
    await expect(
      bob.api.addGroupMember(bob.deviceToken, group_id, 'carol-pink-owl'),
    ).rejects.toThrow();
    alice.close();
    bob.close();
  });

  it('useGroups.upsert merges members on repeated calls', async () => {
    // Mirrors the NewGroupScreen.handleCreate side-effect: after the
    // server addMember loop succeeds, we register the group locally.
    // If the user creates the same group twice (refresh), members
    // should union, not overwrite.
    useGroups.getState().upsert({
      id: 'grp-AAAA',
      name: 'weekend',
      members: ['alice-blue-fox', 'bob-red-bear'],
      createdAt: Date.now(),
    });
    useGroups.getState().upsert({
      id: 'grp-AAAA',
      name: 'weekend',
      members: ['alice-blue-fox', 'carol-pink-owl'],
      createdAt: Date.now(),
    });
    const stored = useGroups.getState().byId['grp-AAAA']!;
    expect(stored.members.sort()).toEqual([
      'alice-blue-fox',
      'bob-red-bear',
      'carol-pink-owl',
    ]);
  });
});
