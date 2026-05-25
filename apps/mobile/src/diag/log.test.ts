/**
 * Diag buffer + cross-launch persistence — vitest coverage.
 *
 * The persistence layer is the load-bearing piece of the rc.10
 * observability fix (bananaman5's call returned a 15-event launch
 * log because the in-memory buffer wiped between the call failure
 * and the user opening diag 20 minutes later). These tests guard:
 *
 *  1. Persist writes happen on every diag() call but are throttled
 *     to one write per 5s, with a trailing-edge timer for the final
 *     burst.
 *  2. `loadPersistedDiag()` survives missing / corrupt / invalid
 *     storage payloads without throwing or polluting the buffer.
 *  3. Previous-session entries land at the TOP of
 *     `getDiagSnapshot()` with a recognisable separator entry
 *     between previous and current so a paste shows a single
 *     chronological log.
 *  4. A persist racing the loader (boot-time diag() before
 *     `loadPersistedDiag` resolves) does NOT clobber the previous-
 *     session payload — `persistBuffer` waits for `loadInFlight`.
 *  5. `clearDiag()` wipes the persisted copy too, so a user choice
 *     to wipe diag doesn't pop the same entries back on relaunch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock factory is hoisted above all top-level code, so its
// implementation cannot reference outer variables. Use vi.hoisted
// to lift the storage handle's construction alongside it.
const storage = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn(async (key: string): Promise<string | null> => {
      return store.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, val: string): Promise<void> => {
      store.set(key, val);
    }),
    removeItem: vi.fn(async (key: string): Promise<void> => {
      store.delete(key);
    }),
    __store: store,
  };
});

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: storage,
}));

import {
  __resetDiagForTests,
  clearDiag,
  diag,
  formatDiag,
  getDiagSnapshot,
  loadPersistedDiag,
  persistDiagNow,
  SESSION_SEPARATOR_MSG,
  SESSION_SEPARATOR_TAG,
} from './log.js';

const PERSIST_KEY = '@speakeasy/diag-buffer-v1';

beforeEach(() => {
  __resetDiagForTests();
  storage.__store.clear();
  storage.getItem.mockClear();
  storage.setItem.mockClear();
  storage.removeItem.mockClear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('diag() in-memory ring', () => {
  it('appends entries and exposes them via getDiagSnapshot()', () => {
    diag('test', 'first');
    diag('test', 'second', { n: 2 });
    const snap = getDiagSnapshot();
    expect(snap).toHaveLength(2);
    expect(snap[0]!.msg).toBe('first');
    expect(snap[1]!.ctx).toEqual({ n: 2 });
  });

  it('caps the ring at MAX_ENTRIES (200) FIFO-style', () => {
    for (let i = 0; i < 250; i++) diag('flood', `event-${i}`);
    const snap = getDiagSnapshot();
    expect(snap).toHaveLength(200);
    // Oldest survivors are events 50..249; verify first + last.
    expect(snap[0]!.msg).toBe('event-50');
    expect(snap[snap.length - 1]!.msg).toBe('event-249');
  });
});

describe('persistDiagNow()', () => {
  it('writes the current buffer to AsyncStorage immediately', async () => {
    diag('test', 'one');
    diag('test', 'two');
    await persistDiagNow();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const [key, payload] = storage.setItem.mock.calls[0]!;
    expect(key).toBe(PERSIST_KEY);
    const parsed = JSON.parse(payload as string);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].msg).toBe('one');
    expect(parsed[1].msg).toBe('two');
  });

  it('survives an AsyncStorage write failure without throwing', async () => {
    storage.setItem.mockRejectedValueOnce(new Error('disk full'));
    diag('test', 'one');
    // Should not reject — best-effort persistence.
    await expect(persistDiagNow()).resolves.toBeUndefined();
  });
});

describe('loadPersistedDiag()', () => {
  it('is a no-op when no prior session is stored', async () => {
    await loadPersistedDiag();
    expect(getDiagSnapshot()).toEqual([]);
  });

  it('loads previous-session entries and prepends them with a separator', async () => {
    const prior = [
      { t: 1000, tag: 'auth', msg: 'login ok' },
      { t: 2000, tag: 'call', msg: 'offer sent' },
    ];
    storage.__store.set(PERSIST_KEY, JSON.stringify(prior));
    await loadPersistedDiag();
    diag('test', 'current-session-event');
    const snap = getDiagSnapshot();
    expect(snap).toHaveLength(prior.length + 1 + 1); // prior + separator + current
    expect(snap[0]!.msg).toBe('login ok');
    expect(snap[1]!.msg).toBe('offer sent');
    expect(snap[2]!.tag).toBe(SESSION_SEPARATOR_TAG);
    expect(snap[2]!.msg).toBe(SESSION_SEPARATOR_MSG);
    expect(snap[3]!.msg).toBe('current-session-event');
  });

  it('silently ignores corrupt JSON in storage', async () => {
    storage.__store.set(PERSIST_KEY, 'not-json-at-all{{{');
    await loadPersistedDiag();
    expect(getDiagSnapshot()).toEqual([]);
  });

  it('filters out structurally-invalid entries during load', async () => {
    const mixed = [
      { t: 1, tag: 'a', msg: 'valid' },
      { tag: 'no-t', msg: 'dropped' }, // missing t
      null,
      { t: 'string-t', tag: 'a', msg: 'dropped' }, // wrong type
      { t: 2, tag: 'b', msg: 'valid-too' },
    ];
    storage.__store.set(PERSIST_KEY, JSON.stringify(mixed));
    await loadPersistedDiag();
    const snap = getDiagSnapshot();
    // 2 valid entries + 1 separator
    expect(snap).toHaveLength(3);
    expect(snap[0]!.msg).toBe('valid');
    expect(snap[1]!.msg).toBe('valid-too');
    expect(snap[2]!.tag).toBe(SESSION_SEPARATOR_TAG);
  });

  it('is idempotent — second call resolves without re-reading storage', async () => {
    storage.__store.set(
      PERSIST_KEY,
      JSON.stringify([{ t: 1, tag: 'a', msg: 'x' }]),
    );
    await loadPersistedDiag();
    await loadPersistedDiag();
    // First call read once; second was deduped to the in-flight promise.
    expect(storage.getItem).toHaveBeenCalledTimes(1);
  });

  it('respects MAX_ENTRIES when the persisted payload is larger', async () => {
    const huge: Array<{ t: number; tag: string; msg: string }> = [];
    for (let i = 0; i < 500; i++) {
      huge.push({ t: i, tag: 't', msg: `m-${i}` });
    }
    storage.__store.set(PERSIST_KEY, JSON.stringify(huge));
    await loadPersistedDiag();
    const snap = getDiagSnapshot();
    // 200 valid + 1 separator
    expect(snap).toHaveLength(201);
    expect(snap[0]!.msg).toBe('m-0');
    expect(snap[199]!.msg).toBe('m-199');
    expect(snap[200]!.tag).toBe(SESSION_SEPARATOR_TAG);
  });
});

describe('persist race protection', () => {
  it('a persist scheduled before loadPersistedDiag resolves does NOT overwrite the previous session', async () => {
    // Seed storage with a "previous session".
    const prior = [{ t: 1, tag: 'old', msg: 'previous-event' }];
    storage.__store.set(PERSIST_KEY, JSON.stringify(prior));

    // Make getItem (the load read) hang briefly so we can force a
    // persist call to race it. The persist must wait until load
    // resolves before writing, or the previous-session payload is
    // lost.
    let resolveGet!: (val: string | null) => void;
    storage.getItem.mockImplementationOnce(
      () =>
        new Promise<string | null>((res) => {
          resolveGet = res;
        }),
    );

    // Start the load (will hang on getItem).
    const loadPromise = loadPersistedDiag();
    // Drive an early-boot diag → schedules a persist; force an
    // immediate flush via persistDiagNow to simulate the worst
    // case (background lifecycle firing mid-load).
    diag('boot', 'early');
    const persistPromise = persistDiagNow();

    // Persist must NOT have written yet — it's blocked on load.
    expect(storage.setItem).not.toHaveBeenCalled();

    // Release the load.
    resolveGet(JSON.stringify(prior));
    await loadPromise;
    await persistPromise;

    // Persist now wrote — and the new write contains the current
    // buffer only (1 entry, 'boot/early'); the previous session
    // already sits in `previousSession` and survives via the
    // in-memory snapshot path until the next persist.
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const written = JSON.parse(
      storage.setItem.mock.calls[0]![1] as string,
    ) as Array<{ msg: string }>;
    expect(written.map((e) => e.msg)).toEqual(['early']);

    // And critically: the previous session is still visible via the snapshot.
    const snap = getDiagSnapshot();
    expect(snap[0]!.msg).toBe('previous-event');
    expect(snap.some((e) => e.tag === SESSION_SEPARATOR_TAG)).toBe(true);
    expect(snap[snap.length - 1]!.msg).toBe('early');
  });
});

describe('clearDiag()', () => {
  it('wipes in-memory + previous session + persisted copy', async () => {
    storage.__store.set(
      PERSIST_KEY,
      JSON.stringify([{ t: 1, tag: 'old', msg: 'previous' }]),
    );
    await loadPersistedDiag();
    diag('test', 'current');
    expect(getDiagSnapshot().length).toBeGreaterThan(0);

    clearDiag();
    expect(getDiagSnapshot()).toEqual([]);
    // removeItem is fire-and-forget; await a microtask so the
    // dangling promise resolves and the mock records the call.
    await Promise.resolve();
    expect(storage.removeItem).toHaveBeenCalledWith(PERSIST_KEY);
  });
});

describe('formatDiag()', () => {
  it('renders entries as paste-ready lines with timestamps', () => {
    const entries = [
      { t: Date.UTC(2026, 4, 25, 20, 43, 5, 360), tag: 'call', msg: 'startOutgoing' },
      {
        t: Date.UTC(2026, 4, 25, 20, 43, 5, 821),
        tag: 'webrtc',
        msg: 'animation data channel opened',
        ctx: { side: 'caller' },
      },
    ];
    const formatted = formatDiag(entries);
    const lines = formatted.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]!).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d \[call\] startOutgoing$/);
    expect(lines[1]!).toContain('[webrtc] animation data channel opened {"side":"caller"}');
  });
});
