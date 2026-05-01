import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage, { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import { useDistributionIds } from './distribution-ids.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('useDistributionIds', () => {
  beforeEach(async () => {
    __resetAsyncStorageMock();
    await useDistributionIds.getState().reset();
  });

  it('mints a v4 UUID on first call for a group', () => {
    const id = useDistributionIds.getState().getOrCreate('grp-1');
    expect(id).toMatch(UUID_RE);
  });

  it('returns the same UUID on subsequent calls for the same group', () => {
    const a = useDistributionIds.getState().getOrCreate('grp-1');
    const b = useDistributionIds.getState().getOrCreate('grp-1');
    expect(a).toBe(b);
  });

  it('mints distinct UUIDs for different groups', () => {
    const a = useDistributionIds.getState().getOrCreate('grp-1');
    const b = useDistributionIds.getState().getOrCreate('grp-2');
    expect(a).not.toBe(b);
  });

  it('reset() clears all allocations', async () => {
    const a = useDistributionIds.getState().getOrCreate('grp-1');
    await useDistributionIds.getState().reset();
    const b = useDistributionIds.getState().getOrCreate('grp-1');
    expect(a).not.toBe(b);
  });

  it('persists distribution IDs across cold start (reload)', async () => {
    // Allocate a distribution ID
    const id = useDistributionIds.getState().getOrCreate('grp-1');
    expect(id).toMatch(UUID_RE);

    // Verify it was persisted to AsyncStorage
    const raw = await AsyncStorage.getItem('speakeasy-distribution-ids');
    expect(raw).not.toBeNull();

    // Simulate process restart: clear in-memory state, then hydrate
    (useDistributionIds.getState() as { byGroup: Record<string, string> }).byGroup = {};
    await useDistributionIds.getState().hydrate();

    // Verify the same ID survived
    const restoredId = useDistributionIds.getState().byGroup['grp-1'];
    expect(restoredId).toBe(id);
  });

  it('hydrate sets hydrated flag', async () => {
    expect(useDistributionIds.getState().hydrated).toBe(false);
    await useDistributionIds.getState().hydrate();
    expect(useDistributionIds.getState().hydrated).toBe(true);
  });

  it('reset clears both in-memory and persisted state', async () => {
    useDistributionIds.getState().getOrCreate('grp-1');
    await useDistributionIds.getState().reset();
    expect(useDistributionIds.getState().byGroup).toEqual({});
    const raw = await AsyncStorage.getItem('speakeasy-distribution-ids');
    expect(raw).toBeNull();
  });
});
