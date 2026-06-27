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
 * **Status (rc.33+):** the DSP is shipped and the native modules
 * return `isAvailable: true` on both Android and iOS. Voice filter
 * runs in-process via `xyz.speakeasyapp.app.voicefilter.VoiceFilterDsp`
 * (phase vocoder pitch shift + cepstral envelope formant shift,
 * Phase 2a/2b). CallTypeSheet's Private row appears in production
 * release builds; previous BuildConfig.DEBUG gate was flipped in
 * 0.7.0-rc.3. Tests still swap a stub to exercise the no-native
 * path; that's a separate concern from production availability.
 */

// Lazy access to react-native — mirrors apps/mobile/src/permissions/runtime.ts.
// Top-level `import 'react-native'` pulls Flow `import typeof` syntax into
// vitest's rollup parse graph and breaks unit tests that transitively
// import this file (orchestrator.test.ts). Lazy require keeps the module
// importable from tests where the native module isn't registered.
interface RnSurface {
  NativeModules: { SpeakeasyVoiceFilter?: NativeVoiceFilterModule };
  Platform: { OS: string };
}
function rn(): RnSurface {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  return require('react-native') as RnSurface;
}

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
  /**
   * Live mask on/off for the active call (#13). `bypassed = true` passes
   * the raw mic through (the user's REAL voice reaches the peer);
   * `false` re-engages the mask. Cheap DSP-state flip on the already-
   * wrapped track — no re-wrap, no renegotiation. Idempotent.
   *
   * Optional on the wire: an older native binary without it simply
   * leaves the JS `setFilterBypass` a no-op (the mask stays on), which
   * fails safe — we never silently reveal the real voice on a binary
   * that can't honor the toggle.
   */
  setBypass?(bypassed: boolean): Promise<void>;
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

function getNative(): NativeVoiceFilterModule | undefined {
  // Wrapped in try/catch because react-native isn't loadable from
  // pure-Node test runners. Returning undefined sends every call
  // path through the runtime_unavailable branch, which is exactly
  // what unit tests of the JS shim want.
  try {
    return rn().NativeModules.SpeakeasyVoiceFilter;
  } catch {
    return undefined;
  }
}

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
/**
 * Pure availability decision, split out so it's unit-testable without the
 * native bridge (the live `isPrivateCallAvailable` reads react-native via a
 * lazy require that throws under vitest).
 *
 * iOS fail-safe (brand-promise critical): the iOS voice mask runs ONLY inside
 * SpeakeasyAudioDevice, the custom RTCAudioDevice. That ADM was disabled in
 * AppDelegate.mm in build 13 because it broke all call audio (we reverted to
 * the stock WebRTC ADM). With it gone, `wrapTrack` still installs the DSP into
 * ActiveFilterHolder and resolves "ok", but NOTHING reads that holder — so a
 * "Private" call would send the user's REAL voice unmasked. Offering the option
 * in that state is worse than not offering it at all. Until the iOS capture
 * path is genuinely re-hooked (see ios/SpeakeasyBridges/VoiceFilter/RE-HOOK.md),
 * Private calls are iOS-off. This mirrors the native `isAvailable:false` flip
 * in VoiceFilterModule.swift; double-gated on purpose.
 */
export function decidePrivateCallAvailable(
  os: string,
  nativeIsAvailable: boolean,
): boolean {
  if (os !== 'ios' && os !== 'android') return false;
  if (os === 'ios') return false; // fail-safe — see docblock
  return nativeIsAvailable === true;
}

export function isPrivateCallAvailable(): boolean {
  let os: string;
  try {
    os = rn().Platform.OS;
  } catch {
    return false;
  }
  const native = getNative();
  return decidePrivateCallAvailable(os, native?.isAvailable === true);
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
  const native = getNative();
  if (!native) throw new FilterError('runtime_unavailable');
  try {
    const result = await native.wrapTrack(trackId, semitones, formantSemitones);
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

/**
 * Live mask on/off for the active call (#13). `bypassed = true` reveals
 * the user's real voice; `false` re-masks. Returns whether the native
 * binary actually honored the toggle: `false` means the running binary
 * has no `setBypass` (older build) so the mask stayed ON — callers MUST
 * treat that as "could not reveal" and keep the chip in the masked state,
 * never silently leaking the real voice.
 */
export async function setFilterBypass(bypassed: boolean): Promise<boolean> {
  const native = getNative();
  if (!native || typeof native.setBypass !== 'function') return false;
  try {
    await native.setBypass(bypassed);
    return true;
  } catch {
    return false;
  }
}

/** Release filter resources for the active call. Idempotent. */
export async function disposeFilter(): Promise<void> {
  const native = getNative();
  if (!native) return;
  try {
    await native.dispose();
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
