import { beforeEach, describe, expect, it } from 'vitest';
import AsyncStorage, { __resetAsyncStorageMock } from '../__mocks__/async-storage.js';
import type { ActiveCall } from '../calls/types.js';
import { type CallHistoryEntry, useCalls } from './calls.js';

const STORAGE_KEY = 'speakeasy.calls.v1';

/** Factory for a history entry. Timestamps are explicit so ordering is
 *  deterministic — no wall-clock sleeps (cf. the flaky blocks.test.ts). */
function entry(partial: Partial<CallHistoryEntry> = {}): CallHistoryEntry {
  return {
    callId: 'call-1',
    peerUserId: 'peer-1',
    isCaller: true,
    startedAt: 1_000,
    endedAt: 2_000,
    durationSec: 1,
    reason: 'completed',
    ...partial,
  };
}

/** Factory for an active call mirror. */
function active(partial: Partial<ActiveCall> = {}): ActiveCall {
  return {
    callId: 'call-1',
    peerUserId: 'peer-1',
    isCaller: true,
    stage: 'connected',
    stageEnteredAt: 1_000,
    micMuted: false,
    speakerOn: false,
    kind: 'audio',
    ...partial,
  };
}

/** Read raw persisted history straight from the AsyncStorage stub. */
async function readPersisted(): Promise<CallHistoryEntry[] | null> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  return raw ? (JSON.parse(raw) as CallHistoryEntry[]) : null;
}

beforeEach(async () => {
  __resetAsyncStorageMock();
  await useCalls.getState().reset();
});

describe('useCalls', () => {
  it('starts empty with no active call and unhydrated history', async () => {
    // reset() in beforeEach flips hydrated to true, so probe the raw
    // initial shape via setState rather than relying on construction.
    useCalls.setState({ active: undefined, history: [], hydrated: false });
    const s = useCalls.getState();
    expect(s.active).toBeUndefined();
    expect(s.history).toEqual([]);
    expect(s.hydrated).toBe(false);
  });

  describe('setActive', () => {
    it('stores the active call mirror', () => {
      const call = active();
      useCalls.getState().setActive(call);
      expect(useCalls.getState().active).toBe(call);
    });

    it('clears the active call when passed undefined', () => {
      useCalls.getState().setActive(active());
      useCalls.getState().setActive(undefined);
      expect(useCalls.getState().active).toBeUndefined();
    });

    it('replaces the active call wholesale', () => {
      useCalls.getState().setActive(active({ stage: 'outgoing_dialing' }));
      useCalls.getState().setActive(active({ stage: 'connected' }));
      expect(useCalls.getState().active?.stage).toBe('connected');
    });

    it('does not touch history', () => {
      useCalls.getState().recordHistory(entry());
      useCalls.getState().setActive(active());
      expect(useCalls.getState().history).toHaveLength(1);
    });
  });

  describe('recordHistory', () => {
    it('appends an entry to an empty history', () => {
      const e = entry();
      useCalls.getState().recordHistory(e);
      expect(useCalls.getState().history).toEqual([e]);
    });

    it('prepends newer entries — newest first', () => {
      useCalls.getState().recordHistory(entry({ callId: 'a' }));
      useCalls.getState().recordHistory(entry({ callId: 'b' }));
      useCalls.getState().recordHistory(entry({ callId: 'c' }));
      expect(useCalls.getState().history.map((h) => h.callId)).toEqual(['c', 'b', 'a']);
    });

    it('does NOT dedup — re-recording the same callId keeps both copies', () => {
      // The store has no dedup; document the actual behavior.
      useCalls.getState().recordHistory(entry({ callId: 'dup' }));
      useCalls.getState().recordHistory(entry({ callId: 'dup' }));
      const ids = useCalls.getState().history.map((h) => h.callId);
      expect(ids).toEqual(['dup', 'dup']);
    });

    it('preserves every field of the recorded entry', () => {
      const e = entry({
        callId: 'rich',
        peerUserId: 'peer-9',
        isCaller: false,
        startedAt: 5_000,
        endedAt: 9_000,
        durationSec: 4,
        reason: 'decline',
      });
      useCalls.getState().recordHistory(e);
      expect(useCalls.getState().history[0]).toEqual(e);
    });

    it('caps history at 100 entries — oldest rolls off the end', () => {
      for (let i = 0; i < 105; i += 1) {
        useCalls.getState().recordHistory(entry({ callId: `c${i}` }));
      }
      const history = useCalls.getState().history;
      expect(history).toHaveLength(100);
      // Newest first: c104 at the head.
      expect(history[0]?.callId).toBe('c104');
      // The 5 oldest (c0..c4) rolled off; c5 is now the tail.
      expect(history[99]?.callId).toBe('c5');
    });

    it('cap boundary — exactly 100 entries are all retained', () => {
      for (let i = 0; i < 100; i += 1) {
        useCalls.getState().recordHistory(entry({ callId: `c${i}` }));
      }
      expect(useCalls.getState().history).toHaveLength(100);
      expect(useCalls.getState().history[99]?.callId).toBe('c0');
    });

    it('persists the (capped) history to AsyncStorage', async () => {
      useCalls.getState().recordHistory(entry({ callId: 'a' }));
      useCalls.getState().recordHistory(entry({ callId: 'b' }));
      // Let the fire-and-forget persist promise settle.
      await Promise.resolve();
      const persisted = await readPersisted();
      expect(persisted?.map((h) => h.callId)).toEqual(['b', 'a']);
    });

    it('persisted snapshot is also capped at 100', async () => {
      for (let i = 0; i < 110; i += 1) {
        useCalls.getState().recordHistory(entry({ callId: `c${i}` }));
      }
      await Promise.resolve();
      const persisted = await readPersisted();
      expect(persisted).toHaveLength(100);
      expect(persisted?.[0]?.callId).toBe('c109');
    });
  });

  describe('hydrate', () => {
    it('loads persisted history from disk', async () => {
      const seeded: CallHistoryEntry[] = [entry({ callId: 'a' }), entry({ callId: 'b' })];
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
      useCalls.setState({ history: [], hydrated: false });

      await useCalls.getState().hydrate();
      expect(useCalls.getState().history.map((h) => h.callId)).toEqual(['a', 'b']);
      expect(useCalls.getState().hydrated).toBe(true);
    });

    it('is a no-op once already hydrated', async () => {
      // Seed disk, but mark the store hydrated — hydrate must not read it.
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([entry({ callId: 'ondisk' })]));
      useCalls.setState({ history: [], hydrated: true });

      await useCalls.getState().hydrate();
      expect(useCalls.getState().history).toEqual([]);
    });

    it('keeps empty history when nothing is persisted, and marks hydrated', async () => {
      useCalls.setState({ history: [], hydrated: false });
      await useCalls.getState().hydrate();
      expect(useCalls.getState().history).toEqual([]);
      expect(useCalls.getState().hydrated).toBe(true);
    });

    it('survives corrupt persisted JSON — non-fatal, still hydrates', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, '{ not valid json');
      useCalls.setState({ history: [], hydrated: false });

      await useCalls.getState().hydrate();
      expect(useCalls.getState().history).toEqual([]);
      expect(useCalls.getState().hydrated).toBe(true);
    });

    it('ignores a non-array persisted value but still marks hydrated', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ not: 'an array' }));
      useCalls.setState({ history: [], hydrated: false });

      await useCalls.getState().hydrate();
      expect(useCalls.getState().history).toEqual([]);
      expect(useCalls.getState().hydrated).toBe(true);
    });

    it('round-trips recorded history across a cold start', async () => {
      useCalls.getState().recordHistory(entry({ callId: 'a' }));
      useCalls.getState().recordHistory(entry({ callId: 'b' }));
      await Promise.resolve();

      // Cold start: drop in-memory state, hydrate from disk.
      useCalls.setState({ history: [], hydrated: false });
      await useCalls.getState().hydrate();
      expect(useCalls.getState().history.map((h) => h.callId)).toEqual(['b', 'a']);
    });
  });

  describe('reset', () => {
    it('wipes active, history, and disk, and marks hydrated', async () => {
      useCalls.getState().setActive(active());
      useCalls.getState().recordHistory(entry());
      await Promise.resolve();

      await useCalls.getState().reset();
      const s = useCalls.getState();
      expect(s.active).toBeUndefined();
      expect(s.history).toEqual([]);
      expect(s.hydrated).toBe(true);
      expect(await readPersisted()).toBeNull();
    });

    it('a hydrate after reset finds nothing on disk', async () => {
      useCalls.getState().recordHistory(entry());
      await Promise.resolve();
      await useCalls.getState().reset();

      // Force a re-hydrate path.
      useCalls.setState({ hydrated: false });
      await useCalls.getState().hydrate();
      expect(useCalls.getState().history).toEqual([]);
    });
  });
});

void AsyncStorage;
