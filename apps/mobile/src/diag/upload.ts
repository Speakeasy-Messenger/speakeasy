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
 *   - Beta only. Hard-gated on either a "-rc." version string or the native
 *     diagnostic-beta build flag. Native store betas label the upload as an
 *     RC for the existing server gate; the actual bundle version is unchanged.
 *   - Opt-out. Gated on the `diagStreaming` settings toggle (default on
 *     for beta, surfaced only on the Diagnostics screen).
 *
 * Fire-and-forget: every failure is swallowed so a diag upload can never
 * turn into a user-visible error or block a call teardown / crash path.
 */
import type { ApiClient } from '../api/client.js';
import { appVersion, isDiagnosticsBetaBuild } from '../version.js';
import { diagImportant, getDiagSnapshot } from './log.js';
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

/** True only on an RC/diagnostic-beta build with the streaming toggle enabled. */
export function isDiagStreamingEnabled(): boolean {
  return (appVersion().includes('-rc.') || isDiagnosticsBetaBuild()) && useSettings.getState().diagStreaming;
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
    const installedVersion = appVersion();
    const uploadVersion =
      isDiagnosticsBetaBuild() && !installedVersion.includes('-rc.')
        ? `${installedVersion}-rc.diag`
        : installedVersion;
    await api.uploadDiag(token, {
      entries,
      appVersion: uploadVersion,
      reason: opts.reason,
      ...(opts.callId ? { callId: opts.callId } : {}),
    });
  } catch (err) {
    // Non-blocking, but visible in the retained ring so "upload" never falsely
    // means delivered when the device was offline or the server rejected it.
    diagImportant('diag-upload', 'upload failed', { callId: opts.callId ?? null, err: String(err) });
  }
}
