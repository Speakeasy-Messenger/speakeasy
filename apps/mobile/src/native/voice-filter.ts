/**
 * Native module bridge for Speakeasy's voice filter (Phase 5j Private
 * Call). The filter wraps the local mic audio track BEFORE it hits the
 * WebRTC encoder so the peer receives a masked voice while the local
 * `AudioLevelMeter` continues to read the unfiltered mic (so the user's
 * own avatar mouth animates accurately).
 *
 * Module name `SpeakeasyVoiceFilter` matches the existing `Speakeasy*`
 * convention. See `xyz.speakeasyapp.app.voicefilter.VoiceFilterModule`
 * (Kotlin) and `SpeakeasyBridges/VoiceFilter/VoiceFilter.swift` (Swift)
 * for the native sides.
 *
 * **Stub status (this commit):** the native module returns
 * `isAvailable: false` on both platforms. The wire/server work below
 * (capability handshake, fan-out filter, KNOWN_CALL_KINDS guard,
 * shared types) lands in main behind this gate so the CallTypeSheet's
 * Private row never appears in production until the real filter ships.
 * Tests can swap an `isAvailable: true` mock to exercise the UI path.
 */

import { NativeModules, Platform } from 'react-native';

interface NativeVoiceFilterModule {
  /**
   * Sync constant resolved at module init. Defaults to false until the
   * native filter binary is bundled and verified on the device.
   */
  isAvailable: boolean;
  /**
   * Wrap a local audio track with the filter. Returns a new track id
   * the orchestrator hands to `peerConnection.addTrack`. The original
   * track stays alive for the local `AudioLevelMeter` so the user's
   * own avatar mouth animates from the unfiltered mic — that's the
   * "speakeasy outfit" the wearer sees in the mirror.
   *
   * `semitones` is the pitch shift. `formantSemitones` is the
   * Phase 2b independent-formant shift (0 = match pitch shift,
   * preserves rc.18 behavior; > 0 = formants up, smaller-sounding
   * vocal tract; < 0 = formants down, larger-sounding). Together
   * they let each profile have a genuinely different voice
   * character, not just a different pitch height.
   *
   * Both nullable on the wire so an older native binary running
   * against a newer JS bundle still works — native falls back to
   * its built-in defaults.
   *
   * Rejects with one of the typed codes in `FilterErrorCode`. The
   * orchestrator maps each to user-facing copy + a metric tag.
   */
  wrapTrack(
    trackId: string,
    semitones: number | null,
    formantSemitones: number | null,
  ): Promise<{ filteredTrackId: string }>;
  /** Release filter resources for the active call. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Typed error codes the native side rejects with. The orchestrator
 * switch maps each to a `CallEndReason` + UI copy. Centralized here so
 * adding a new code touches one file.
 */
export type FilterErrorCode =
  | 'asset_missing'
  | 'oom'
  | 'unsupported'
  | 'runtime_unavailable'
  | 'init_timeout'
  | 'latency_exceeded'
  | 'corrupt_output'
  | 'engine_restart_failed'
  | 'route_lost';

export class FilterError extends Error {
  constructor(public readonly code: FilterErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'FilterError';
  }
}

const NATIVE: NativeVoiceFilterModule | undefined = (
  NativeModules as { SpeakeasyVoiceFilter?: NativeVoiceFilterModule }
).SpeakeasyVoiceFilter;

/**
 * True when the native filter is present AND reports itself ready on
 * this device. The CallTypeSheet checks this BEFORE showing the
 * Private row; if false, the row stays hidden — the user never sees
 * an option they cannot use.
 *
 * Returns false in dev/test environments where the native module
 * isn't registered, and false on platforms (e.g. web) where it
 * doesn't exist. False until proven true.
 */
export function isPrivateCallAvailable(): boolean {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  if (!NATIVE) return false;
  return NATIVE.isAvailable === true;
}

/**
 * Wrap a local audio track with the filter. Throws `FilterError` on
 * failure. Callers (orchestrator) catch and map to a `call_end` with
 * reason `filter_failure` + the inline failure UI on CallScreen.
 *
 * `semitones` is the pitch shift; `formantSemitones` is the Phase 2b
 * independent formant shift. See voice-filter-profiles.ts for the
 * Smoke/Velvet/Glass values. Pass `null` for either to fall back to
 * the native default.
 */
export async function wrapTrackWithFilter(
  trackId: string,
  semitones: number | null,
  formantSemitones: number | null,
): Promise<string> {
  if (!isPrivateCallAvailable()) {
    throw new FilterError('runtime_unavailable');
  }
  try {
    const result = await NATIVE!.wrapTrack(trackId, semitones, formantSemitones);
    return result.filteredTrackId;
  } catch (err) {
    // RN promise rejections from native carry a `.code` string when the
    // module rejected with promise.reject(code, message). Re-wrap with
    // our typed enum so the orchestrator can switch on a known set.
    const code = (err as { code?: string } | null)?.code;
    if (code && isFilterErrorCode(code)) {
      throw new FilterError(code, String(err));
    }
    throw new FilterError('runtime_unavailable', String(err));
  }
}

/** Release filter resources for the active call. Idempotent. */
export async function disposeFilter(): Promise<void> {
  if (!NATIVE) return;
  try {
    await NATIVE.dispose();
  } catch {
    /* dispose is best-effort; engine will be torn down by call_end anyway */
  }
}

const FILTER_ERROR_CODES = new Set<FilterErrorCode>([
  'asset_missing',
  'oom',
  'unsupported',
  'runtime_unavailable',
  'init_timeout',
  'latency_exceeded',
  'corrupt_output',
  'engine_restart_failed',
  'route_lost',
]);

function isFilterErrorCode(code: string): code is FilterErrorCode {
  return FILTER_ERROR_CODES.has(code as FilterErrorCode);
}
