/**
 * Ownership store — minimal regression coverage for the operations
 * the picker / acquire sheet rely on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { useOwnership } from './ownership.js';

describe('useOwnership', () => {
  beforeEach(async () => {
    await useOwnership.getState().reset();
  });

  it('starts empty', () => {
    expect(useOwnership.getState().ownedSkus).toEqual({});
    expect(useOwnership.getState().hasOwnership('com.speakeasy.avatar.rare.lynx')).toBe(false);
  });

  it('markOwned flips a sku to owned', () => {
    useOwnership.getState().markOwned('com.speakeasy.avatar.rare.lynx');
    expect(useOwnership.getState().hasOwnership('com.speakeasy.avatar.rare.lynx')).toBe(true);
    expect(useOwnership.getState().ownedSkus['com.speakeasy.avatar.rare.lynx']).toBe(true);
  });

  it('markOwned is idempotent — repeat calls are no-ops at the state level', () => {
    useOwnership.getState().markOwned('com.speakeasy.avatar.rare.lynx');
    const before = useOwnership.getState().ownedSkus;
    useOwnership.getState().markOwned('com.speakeasy.avatar.rare.lynx');
    const after = useOwnership.getState().ownedSkus;
    // Reference stability protects picker selectors — a second
    // mark-owned shouldn't trigger a re-render.
    expect(after).toBe(before);
  });

  it('markOwned replaces by reference on a true write — selectors fire', () => {
    const a = useOwnership.getState().ownedSkus;
    useOwnership.getState().markOwned('com.speakeasy.avatar.rare.lynx');
    const b = useOwnership.getState().ownedSkus;
    expect(b).not.toBe(a);
  });

  it('restore stamps lastRestoreAt', async () => {
    expect(useOwnership.getState().lastRestoreAt).toBeNull();
    await useOwnership.getState().restore();
    expect(useOwnership.getState().lastRestoreAt).not.toBeNull();
  });

  it('reset clears ownership AND lastRestoreAt', async () => {
    useOwnership.getState().markOwned('com.speakeasy.avatar.rare.lynx');
    await useOwnership.getState().restore();
    await useOwnership.getState().reset();
    expect(useOwnership.getState().ownedSkus).toEqual({});
    expect(useOwnership.getState().lastRestoreAt).toBeNull();
  });
});
