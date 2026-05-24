package xyz.speakeasyapp.app.voicefilter

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import xyz.speakeasyapp.app.BuildConfig
import xyz.speakeasyapp.app.voicefilter.dsp.VoiceFilterDsp

/**
 * Speakeasy Voice Filter — Android side of the Phase 5j Private Call
 * native module. JS contract lives at `apps/mobile/src/native/voice-filter.ts`.
 *
 * `wrapTrack` installs a [VoiceFilterDsp] into the process-wide
 * [ActiveFilterHolder]. The forked
 * [org.webrtc.audio.WebRtcAudioRecord] reads the holder on every
 * captured frame and runs the DSP in-place before pushing to the
 * native ADM. `dispose` clears the holder and the next frame goes
 * through unfiltered (used when ending a Private Call cleanly).
 *
 * `isAvailable` stays gated on `BuildConfig.DEBUG` so the Private
 * row in CallTypeSheet only appears in dev builds until the founder
 * flips the release flag. The brand-promise failure-closed posture
 * lives in the JS shim's `isPrivateCallAvailable()` gate; this
 * module also rejects `wrapTrack` outside debug, and the WebRTC
 * fork mutes the mic on filter-process failure (latency-tripped,
 * RuntimeException, etc.) so unfiltered audio never reaches the
 * encoder.
 *
 * Error codes returned via `promise.reject(code, ...)` must stay in
 * the `FilterErrorCode` union in `voice-filter.ts`. The JS side maps
 * each to a typed `FilterError` the orchestrator switches on.
 */
class VoiceFilterModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = NAME

  override fun getConstants(): Map<String, Any> = mapOf(
      // Dev/debug builds only until the founder flips the flag for
      // release. Release builds stay invisible end-to-end (the JS
      // shim's `isPrivateCallAvailable()` checks this constant).
      "isAvailable" to BuildConfig.DEBUG,
  )

  @ReactMethod
  fun wrapTrack(trackId: String, promise: Promise) {
    if (!BuildConfig.DEBUG) {
      promise.reject("runtime_unavailable", "voice filter not built into release")
      return
    }
    // The JS shim doesn't actually need a new track id — the filter
    // wraps the same track's samples in place via the ADM fork. We
    // return the original id so the orchestrator's call to
    // `pc.addTrack(wrapped)` adds the same MediaStreamTrack handle,
    // and the AudioLevelMeter (which reads the unfiltered mic for
    // the user's own avatar) continues to work.
    val dsp = VoiceFilterDsp(semitones = DEFAULT_SHIFT_SEMITONES)
    ActiveFilterHolder.setFilter(dsp)
    val result = Arguments.createMap().apply {
      putString("filteredTrackId", trackId)
    }
    promise.resolve(result)
  }

  @ReactMethod
  fun dispose(promise: Promise) {
    // Idempotent. Clearing the holder makes the next captured frame
    // skip the filter — what the orchestrator wants when the user
    // hangs up cleanly. For a `latency_exceeded` mid-call failure
    // the orchestrator ends the call AND calls dispose; the WebRTC
    // fork's mute-on-fail behavior covers the in-flight frames.
    ActiveFilterHolder.setFilter(null)
    promise.resolve(null)
  }

  companion object {
    const val NAME = "SpeakeasyVoiceFilter"

    /**
     * Default pitch + formant shift in semitones. Negative sounds
     * "deeper" / more disguised; the locked v1 plan picked this side.
     * Configurable from the orchestrator later (per call, per
     * peer) if the founder wants A/B testing.
     */
    private const val DEFAULT_SHIFT_SEMITONES = -2f
  }
}
