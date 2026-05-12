/**
 * Profiles store — covers the rc.6 raven→pigeon hydration migration.
 * Earlier alpha builds shipped 'raven' as a free common bird; rc.6
 * reassigns 'raven' to a paid rare and renames the common to 'pigeon'.
 * Any cached selection that referenced 'raven' must be remapped on
 * rehydrate so users don't suddenly appear as the unowned rare.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const memoryStore = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => memoryStore.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      memoryStore.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      memoryStore.delete(key);
    }),
  },
}));

import { useProfiles } from './profiles.js';

const STORAGE_KEY = 'speakeasy.profiles.v2';

describe('useProfiles raven→pigeon migration', () => {
  beforeEach(async () => {
    memoryStore.clear();
    await useProfiles.getState().reset();
  });

  it("rewrites a pre-rc.6 'raven' selection to 'pigeon' on hydrate", async () => {
    memoryStore.set(
      STORAGE_KEY,
      JSON.stringify({
        'usr-alice': { selectedAvatarId: 'raven', fetchedAt: 100 },
        'usr-bob': { selectedAvatarId: 'fox', fetchedAt: 200 },
      }),
    );
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().byUserId['usr-alice']?.selectedAvatarId).toBe('pigeon');
    expect(useProfiles.getState().byUserId['usr-bob']?.selectedAvatarId).toBe('fox');
  });

  it('persists the migrated map back to storage', async () => {
    memoryStore.set(
      STORAGE_KEY,
      JSON.stringify({
        'usr-alice': { selectedAvatarId: 'raven', fetchedAt: 100 },
      }),
    );
    await useProfiles.getState().hydrate();
    const persisted = JSON.parse(memoryStore.get(STORAGE_KEY)!);
    expect(persisted['usr-alice'].selectedAvatarId).toBe('pigeon');
  });

  it('leaves an empty cache untouched', async () => {
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().byUserId).toEqual({});
  });

  it('preserves fetchedAt on the migrated entry', async () => {
    memoryStore.set(
      STORAGE_KEY,
      JSON.stringify({
        'usr-alice': { selectedAvatarId: 'raven', fetchedAt: 12345 },
      }),
    );
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().byUserId['usr-alice']?.fetchedAt).toBe(12345);
  });
});
