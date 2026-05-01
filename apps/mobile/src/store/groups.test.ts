import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage, { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import { useGroups, type Group } from './groups.js';

beforeEach(async () => {
  __resetAsyncStorageMock();
  await useGroups.getState().reset();
});

const baseGroup = (overrides: Partial<Group> = {}): Group => ({
  id: 'grp-abc123',
  name: 'movie night',
  members: ['alice-blue-fox', 'silent-golden-hawk'],
  createdAt: 1_000_000,
  ...overrides,
});

describe('useGroups', () => {
  it('upsert creates a new group', () => {
    useGroups.getState().upsert(baseGroup());
    const g = useGroups.getState().byId['grp-abc123'];
    expect(g?.name).toBe('movie night');
    expect(g?.members).toEqual(['alice-blue-fox', 'silent-golden-hawk']);
  });

  it('upsert merges members + preserves name when re-upserted', () => {
    useGroups.getState().upsert(baseGroup());
    useGroups.getState().upsert(
      baseGroup({
        name: '', // empty — should NOT clobber the existing name
        members: ['silent-golden-hawk', 'carol-red-bear'],
      }),
    );
    const g = useGroups.getState().byId['grp-abc123']!;
    expect(g.name).toBe('movie night');
    expect(g.members.sort()).toEqual(['alice-blue-fox', 'carol-red-bear', 'silent-golden-hawk']);
  });

  it('addMember appends to existing group, dedupes', () => {
    useGroups.getState().upsert(baseGroup());
    useGroups.getState().addMember('grp-abc123', 'carol-red-bear');
    useGroups.getState().addMember('grp-abc123', 'alice-blue-fox'); // dup
    const g = useGroups.getState().byId['grp-abc123']!;
    expect(g.members).toEqual(['alice-blue-fox', 'silent-golden-hawk', 'carol-red-bear']);
  });

  it('addMember is a no-op for unknown group', () => {
    useGroups.getState().addMember('grp-ghost', 'alice-blue-fox');
    expect(useGroups.getState().byId['grp-ghost']).toBeUndefined();
  });

  it('persists groups across cold start (reload)', async () => {
    // Create a group in the first store instance
    useGroups.getState().upsert(baseGroup());

    // Simulate cold start: create a fresh store instance and hydrate
    // Since Zustand stores are singletons, we simulate a reload by:
    // 1. The data should already be persisted to AsyncStorage
    // 2. Reset the in-memory state (simulate process restart)
    // 3. Hydrate from AsyncStorage
    const raw = await AsyncStorage.getItem('speakeasy-groups');
    expect(raw).not.toBeNull();

    // Simulate process restart: clear in-memory state, then hydrate
    (useGroups.getState() as { byId: Record<string, Group> }).byId = {};
    await useGroups.getState().hydrate();

    // Verify the group survived
    const g = useGroups.getState().byId['grp-abc123'];
    expect(g?.name).toBe('movie night');
    expect(g?.members).toEqual(['alice-blue-fox', 'silent-golden-hawk']);
  });

  it('hydrate sets hydrated flag', async () => {
    expect(useGroups.getState().hydrated).toBe(false);
    await useGroups.getState().hydrate();
    expect(useGroups.getState().hydrated).toBe(true);
  });

  it('reset clears both in-memory and persisted state', async () => {
    useGroups.getState().upsert(baseGroup());
    await useGroups.getState().reset();
    expect(useGroups.getState().byId).toEqual({});
    const raw = await AsyncStorage.getItem('speakeasy-groups');
    expect(raw).toBeNull();
  });
});
