import { beforeEach, describe, expect, it } from 'vitest';
import { useGroups, type Group } from './groups.js';

beforeEach(() => useGroups.getState().reset());

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
});
