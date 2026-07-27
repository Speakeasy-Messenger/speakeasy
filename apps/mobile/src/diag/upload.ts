/**
 * Beta-only diagnostic log streaming.
 *
 * Why this exists: alpha/beta testers have no logcat access, so every
 * silent failure turned into a "please open Diagnostics and paste the
 * log back to me" round-trip — and half the time the buffer had already
 * rolled or the process had restarted (see `diag/log.ts`). This uploads
 * the SAME already-redacted ring buffer the Diagnostics screen shows,
 * keyed by `callId` so both sides of a failed call auto-correlate on the
 * server without anyone copy-pasting anything.
 *
 * Privacy posture (load-bearing — do not weaken):
 *   - Metadata only. The buffer is redacted at write time in
 *     `diag/log.ts` (handles + previews are one-way fingerprints; no
 *     message plaintext is ever recorded). This module ships that buffer
 *     verbatim and adds nothing.
 *   - Beta only. Hard-gated on a "-rc." version string. GA builds never
 *     upload, and the server independently 403s non-beta versions.
 *   - Opt-out. Gated on the `diagStreaming` settings toggle (default on
 *     for beta, surfaced only on the Diagnostics screen).
 *
 * Fire-and-forget: every failure is swallowed so a diag upload can never
 * turn into a user-visible error or block a call teardown / crash path.
 */
import type { ApiClient } from '../api/client.js';
import { appVersion } from '../version.js';
import { getDiagSnapshot } from './log.js';
import { useSettings } from '../store/settings.js';
import { useIdentity } from '../store/identity.js';

/** Cap the upload to the ring-buffer size regardless of previous-session prepend. */
const MAX_UPLOAD_ENTRIES = 200;

export interface UploadDiagOpts {
  /** Why we're uploading, e.g. 'manual', 'crash', 'call_failed'. */
  reason: string;
  /** Correlates both sides of the same call when present. */
  callId?: string;
}

/**
 * Injectable seams — production resolves them from the module singletons;
 * tests pass explicit fakes so they don't drag in `services.ts` (which
 * constructs native clients at import time).
 */
export interface UploadDiagDeps {
  api: Pick<ApiClient, 'uploadDiag'>;
  /** Cached Vouchflow device token; undefined before enrollment. */
  getDeviceToken: () => string | undefined;
}

/** True only on a beta ("-rc.") build with the streaming toggle enabled. */
export function isDiagStreamingEnabled(): boolean {
  return appVersion().includes('-rc.') && useSettings.getState().diagStreaming;
}

/**
 * Upload the current diag buffer. No-op (and never throws) unless the
 * build is beta AND the toggle is on AND a device token is available.
 */
export async function uploadDiag(
  opts: UploadDiagOpts,
  deps?: UploadDiagDeps,
): Promise<void> {
  try {
    if (!isDiagStreamingEnabled()) return;

    const getToken =
      deps?.getDeviceToken ?? (() => useIdentity.getState().deviceToken);
    const token = getToken();
    if (!token) return;

    // Lazy import so `services.ts` (and its native clients) only loads on
    // the production path, never when a test drives `uploadDiag` directly.
    const api = deps?.api ?? (await import('../services.js')).api;

    const entries = getDiagSnapshot().slice(-MAX_UPLOAD_ENTRIES);
    await api.uploadDiag(token, {
      entries,
      appVersion: appVersion(),
      reason: opts.reason,
      ...(opts.callId ? { callId: opts.callId } : {}),
    });
  } catch {
    /* fire-and-forget — a diag upload must never surface to the user */
  }
}
