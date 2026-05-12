import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage, { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import { useBlocks } from './blocks.js';

beforeEach(async () => {
  __resetAsyncStorageMock();
  await useBlocks.getState().reset();
});

describe('useBlocks', () => {
  it('isBlocked returns false for unknown handles', () => {
    expect(useBlocks.getState().isBlocked('amber')).toBe(false);
  });

  it('block records a handle with a timestamp', () => {
    const before = Date.now();
    useBlocks.getState().block('amber');
    const entry = useBlocks.getState().byHandle.amber;
    expect(entry?.handle).toBe('amber');
    expect(entry?.blockedAt).toBeGreaterThanOrEqual(before);
    expect(useBlocks.getState().isBlocked('amber')).toBe(true);
  });

  it('block is idempotent — re-blocking preserves the original timestamp', () => {
    useBlocks.getState().block('amber');
    const firstAt = useBlocks.getState().byHandle.amber?.blockedAt;
    useBlocks.getState().block('amber');
    expect(useBlocks.getState().byHandle.amber?.blockedAt).toBe(firstAt);
  });

  it('unblock removes the handle', () => {
    useBlocks.getState().block('amber');
    useBlocks.getState().unblock('amber');
    expect(useBlocks.getState().byHandle.amber).toBeUndefined();
    expect(useBlocks.getState().isBlocked('amber')).toBe(false);
  });

  it('list() sorts by blockedAt desc — newest first', async () => {
    useBlocks.getState().block('amber');
    // ms-precision tick so the next entry's timestamp differs
    await new Promise((r) => setTimeout(r, 2));
    useBlocks.getState().block('lyra');
    await new Promise((r) => setTimeout(r, 2));
    useBlocks.getState().block('kim');
    const handles = useBlocks.getState().list().map((e) => e.handle);
    expect(handles).toEqual(['kim', 'lyra', 'amber']);
  });

  it('persists blocks across hydrate', async () => {
    useBlocks.getState().block('amber');
    useBlocks.getState().block('lyra');
    // Settle the persist promise.
    await Promise.resolve();
    // Cold start: clear in-memory, hydrate from disk.
    useBlocks.setState({ byHandle: {}, hydrated: false });
    await useBlocks.getState().hydrate();
    expect(useBlocks.getState().isBlocked('amber')).toBe(true);
    expect(useBlocks.getState().isBlocked('lyra')).toBe(true);
    expect(useBlocks.getState().hydrated).toBe(true);
  });

  it('hydrate keeps empty state when nothing is persisted', async () => {
    await useBlocks.getState().hydrate();
    expect(Object.keys(useBlocks.getState().byHandle)).toEqual([]);
    expect(useBlocks.getState().hydrated).toBe(true);
  });

  it('reset wipes both memory and disk', async () => {
    useBlocks.getState().block('amber');
    await Promise.resolve();
    await useBlocks.getState().reset();
    expect(Object.keys(useBlocks.getState().byHandle)).toEqual([]);
    // After reset hydrate should still find no entries.
    await useBlocks.getState().hydrate();
    expect(Object.keys(useBlocks.getState().byHandle)).toEqual([]);
  });

  it('byHandle reference is stable when no mutation occurs (rc.4 BlockList crash regression)', () => {
    const initial = useBlocks.getState().byHandle;
    // Selecting `byHandle` should yield the same reference each
    // call until something actually mutates the store. This is
    // the property the BlockListScreen depends on after the rc.5
    // fix that switched away from `useBlocks((s) => s.list())`.
    expect(useBlocks.getState().byHandle).toBe(initial);
    useBlocks.getState().block('amber');
    expect(useBlocks.getState().byHandle).not.toBe(initial);
  });
});

void AsyncStorage;
