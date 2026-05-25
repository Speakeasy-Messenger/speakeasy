/**
 * In-process diagnostic ring buffer + cross-launch persistence.
 *
 * Why this exists: we ship to alpha testers who don't have logcat
 * access (no USB, no PC). When something silently fails — the bug class
 * for self-DM not echoing back, for example — there's no way to see
 * what the JS layer did. This module keeps the most-recent N events in
 * a ring and exposes them via a "Diagnostics" affordance on the
 * Conversations screen so the user can paste them back.
 *
 * Cross-launch persistence (rc.10): the in-memory buffer is wiped on
 * every process restart, so any bug that crashes or backgrounds the
 * app between failure and the user opening diag is invisible — which
 * is exactly the class of bug we couldn't debug in rc.6 / rc.8 / rc.9
 * (bananaman5 returned a 15-event launch-only diag for a call that
 * had failed 20 minutes earlier; the call-period events were already
 * gone). The buffer is now persisted to AsyncStorage on background
 * lifecycle + on a 5 s throttle while running. On launch, the
 * previous session's entries load into `previousSession` and prepend
 * `getDiagSnapshot()` with an inline separator entry between them,
 * so the user pastes a single chronological log.
 *
 * Not a replacement for crash capture (that's the inline native writer
 * in MainApplication.kt). This is for *successful-but-wrong* code paths
 * and silent-failure post-mortems.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const MAX_ENTRIES = 200;
const PERSIST_KEY = '@speakeasy/diag-buffer-v1';
const PERSIST_THROTTLE_MS = 5000;

/**
 * Tag used on the synthetic boundary entry inserted between previous
 * and current session in `getDiagSnapshot()`. Exported as a constant
 * so tests + any future UI rendering can recognize it without
 * pattern-matching on free-form text.
 */
export const SESSION_SEPARATOR_TAG = 'session';
export const SESSION_SEPARATOR_MSG =
  '=== PREVIOUS SESSION ABOVE / CURRENT SESSION BELOW ===';

export interface DiagEntry {
  /** Wall-clock ms. */
  t: number;
  /** Short tag for grouping (e.g. 'router', 'send', 'auth'). */
  tag: string;
  /** Free-form message + optional structured context. */
  msg: string;
  ctx?: Record<string, unknown>;
}

const buffer: DiagEntry[] = [];
let previousSession: DiagEntry[] = [];
const subscribers = new Set<(entries: DiagEntry[]) => void>();

let persistTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Set while `loadPersistedDiag()` is in flight. `persistBuffer()`
 * awaits it before writing so a persist scheduled during early boot
 * cannot clobber the previous-session payload before the loader has
 * a chance to read it.
 */
let loadInFlight: Promise<void> | undefined;

export function diag(tag: string, msg: string, ctx?: Record<string, unknown>): void {
  const entry: DiagEntry = { t: Date.now(), tag, msg, ctx };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  schedulePersist();
  for (const s of subscribers) {
    try {
      s(buffer);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Returns the full diag history available to the user: any
 * previous-session entries (loaded from AsyncStorage at boot) followed
 * by a synthetic separator entry followed by the current in-memory
 * buffer. Returns the current buffer only when no previous session
 * was loaded.
 */
export function getDiagSnapshot(): DiagEntry[] {
  if (previousSession.length === 0) return buffer.slice();
  return [...previousSession, ...buffer];
}

export function subscribeDiag(cb: (entries: DiagEntry[]) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function clearDiag(): void {
  buffer.length = 0;
  previousSession = [];
  for (const s of subscribers) {
    try {
      s(buffer);
    } catch {
      /* ignore */
    }
  }
  // Wipe persisted state too — a user who chose to clear diag would
  // be confused to see the same entries pop back after a relaunch.
  void AsyncStorage.removeItem(PERSIST_KEY).catch(() => undefined);
}

/** Format a snapshot as a paste-ready text block. */
export function formatDiag(entries: DiagEntry[]): string {
  return entries
    .map((e) => {
      const ts = new Date(e.t).toISOString().slice(11, 23); // HH:MM:SS.mmm
      const ctx = e.ctx ? ` ${JSON.stringify(e.ctx)}` : '';
      return `${ts} [${e.tag}] ${e.msg}${ctx}`;
    })
    .join('\n');
}

/**
 * Load the previous session's persisted buffer from AsyncStorage so
 * it's available at the top of `getDiagSnapshot()`. Idempotent;
 * subsequent calls are no-ops. Best-effort: any storage / JSON
 * failure leaves `previousSession` empty (i.e. degrades to the
 * old in-memory-only behavior, not to a crash).
 *
 * Call once at app boot, as early as possible — any persist
 * scheduled before this returns is held until load completes, so
 * calling it after early-boot diag() invocations is safe.
 */
export async function loadPersistedDiag(): Promise<void> {
  if (loadInFlight) return loadInFlight;
  loadInFlight = (async () => {
    try {
      const raw = await AsyncStorage.getItem(PERSIST_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length === 0) return;
      const valid: DiagEntry[] = [];
      for (const item of parsed) {
        if (isDiagEntry(item)) {
          valid.push(item);
          if (valid.length >= MAX_ENTRIES) break;
        }
      }
      const lastEntry = valid[valid.length - 1];
      if (!lastEntry) return;
      const separator: DiagEntry = {
        t: lastEntry.t + 1,
        tag: SESSION_SEPARATOR_TAG,
        msg: SESSION_SEPARATOR_MSG,
      };
      previousSession = [...valid, separator];
    } catch {
      /* corrupt JSON / storage missing — best-effort */
    }
  })();
  return loadInFlight;
}

/**
 * Persist immediately, bypassing the throttle. Wire to the AppState
 * background lifecycle so the seconds of activity that wouldn't
 * survive a process kill are flushed first.
 */
export async function persistDiagNow(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  await persistBuffer();
}

async function persistBuffer(): Promise<void> {
  // Block any persist until the loader either resolves or rejects.
  // Without this gate, a persist scheduled during early boot races
  // the loader and can overwrite the previous-session payload with
  // an empty (or near-empty) buffer before we've read it.
  if (loadInFlight) {
    try {
      await loadInFlight;
    } catch {
      /* loader itself swallows errors; just unblock */
    }
  }
  try {
    await AsyncStorage.setItem(PERSIST_KEY, JSON.stringify(buffer));
  } catch {
    /* best-effort */
  }
}

/**
 * Schedule a trailing-edge persist within `PERSIST_THROTTLE_MS`.
 * A burst of diag() calls inside the throttle window all share the
 * same already-scheduled timer, so the final state is captured
 * exactly once per 5 s window. `persistDiagNow()` short-circuits
 * the timer for lifecycle-driven flushes.
 */
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    void persistBuffer();
  }, PERSIST_THROTTLE_MS);
}

function isDiagEntry(item: unknown): item is DiagEntry {
  if (item === null || typeof item !== 'object') return false;
  const e = item as Partial<DiagEntry>;
  return (
    typeof e.t === 'number' &&
    typeof e.tag === 'string' &&
    typeof e.msg === 'string'
  );
}

/**
 * Test-only: reset every piece of module-level state so individual
 * vitest cases don't bleed into each other. Not part of the public
 * API; callers in production code should not touch this.
 */
export function __resetDiagForTests(): void {
  buffer.length = 0;
  previousSession = [];
  subscribers.clear();
  loadInFlight = undefined;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
}
