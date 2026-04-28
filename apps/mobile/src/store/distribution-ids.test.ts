import { beforeEach, describe, expect, it } from 'vitest';
import { useDistributionIds } from './distribution-ids.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('useDistributionIds', () => {
  beforeEach(() => {
    useDistributionIds.getState().reset();
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

  it('reset() clears all allocations', () => {
    const a = useDistributionIds.getState().getOrCreate('grp-1');
    useDistributionIds.getState().reset();
    const b = useDistributionIds.getState().getOrCreate('grp-1');
    expect(a).not.toBe(b);
  });
});
