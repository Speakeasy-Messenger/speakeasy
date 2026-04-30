/**
 * In-process diagnostic ring buffer.
 *
 * Why this exists: we ship to alpha testers who don't have logcat
 * access (no USB, no PC). When something silently fails — the bug class
 * for self-DM not echoing back, for example — there's no way to see
 * what the JS layer did. This module keeps the most-recent N events in
 * a ring and exposes them via a "Diagnostics" affordance on the
 * Conversations screen so the user can paste them back.
 *
 * Not a replacement for crash capture (that's the inline native writer
 * in MainApplication.kt). This is for *successful-but-wrong* code paths.
 */

const MAX_ENTRIES = 200;

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
const subscribers = new Set<(entries: DiagEntry[]) => void>();

export function diag(tag: string, msg: string, ctx?: Record<string, unknown>): void {
  const entry: DiagEntry = { t: Date.now(), tag, msg, ctx };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) {
    buffer.splice(0, buffer.length - MAX_ENTRIES);
  }
  for (const s of subscribers) {
    try {
      s(buffer);
    } catch {
      /* ignore */
    }
  }
}

export function getDiagSnapshot(): DiagEntry[] {
  return buffer.slice();
}

export function subscribeDiag(cb: (entries: DiagEntry[]) => void): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function clearDiag(): void {
  buffer.length = 0;
  for (const s of subscribers) {
    try {
      s(buffer);
    } catch {
      /* ignore */
    }
  }
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
